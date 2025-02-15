import { Pinecone } from "@pinecone-database/pinecone";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import fetch from "node-fetch";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { HfInference } from "@huggingface/inference";
import { Groq } from "groq-sdk";

const fastify = Fastify({
  logger: true,
});

// --------------------------------------------------------------------
// Environment / Feature Flags
//   When DISABLE_EMBEDDINGS === "0", we DISABLE embedding logic.
// --------------------------------------------------------------------
const disableEmbeddings = process.env.DISABLE_EMBEDDINGS === "0";

// --------------------------------------------------------------------
// SQLite Initialization
// --------------------------------------------------------------------
let db: any;

async function initDB() {
  db = await open({
    filename: "./agentDatabase.db",
    driver: sqlite3.Database,
  });

  await db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      domain TEXT NOT NULL,
      tone TEXT NOT NULL
    );
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId INTEGER NOT NULL,
      workflowJson TEXT NOT NULL,
      FOREIGN KEY (agentId) REFERENCES agents(id)
    );
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS long_term_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (agentId) REFERENCES agents(id)
    );
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      sessionId TEXT PRIMARY KEY,
      agentId INTEGER NOT NULL,
      currentNode TEXT NOT NULL,
      context TEXT,
      FOREIGN KEY (agentId) REFERENCES agents(id)
    );
  `);
}

// --------------------------------------------------------------------
// Pinecone Initialization (Used only if embeddings enabled)
// --------------------------------------------------------------------
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = "agent-knowledge-index";

const pinecone = new Pinecone({
  apiKey: PINECONE_API_KEY,
});

async function initPinecone() {
  if (disableEmbeddings) {
    return null;
  }
  return pinecone.Index(PINECONE_INDEX);
}

// --------------------------------------------------------------------
// Hugging Face Inference Initialization (Used unless embeddings are disabled)
// --------------------------------------------------------------------
const hf = new HfInference(process.env.HF_API_KEY);

async function getHuggingFaceEmbeddings(texts: string[]): Promise<number[][]> {
  if (disableEmbeddings) {
    // Return zero vectors if embeddings are disabled
    return texts.map(() => Array(384).fill(0));
  }

  const validTexts = texts.filter(
    (text, idx) =>
      typeof text === "string" && text.trim().length > 0 && idx < 100
  );

  if (validTexts.length === 0) {
    throw new Error("No valid input texts provided for embedding.");
  }

  const embeddings: number[][] = [];

  for (const text of validTexts) {
    try {
      const response = await hf.featureExtraction({
        model: "sentence-transformers/all-MiniLM-L6-v2",
        inputs: text,
      });
      embeddings.push(response as number[]);
    } catch (error) {
      console.error("Error generating embeddings for text:", text, error);
      throw error;
    }
  }

  return embeddings;
}

// --------------------------------------------------------------------
// GROQ SDK for LLM Generation of "pleasing" responses
// --------------------------------------------------------------------
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// A helper function to call the Groq LLM
async function generateLLMResponse(
  userMessage: string,
  context: string
): Promise<string> {
  try {
    // Using an example model from Groq
    const result = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful AI assistant. Use the context to provide a pleasing and concise answer. Keep it relevant, but well-phrased.",
        },
        {
          role: "user",
          content: `User's query:\n${userMessage}\nRelevant Context:\n${context}`,
        },
      ],
    });

    if (result?.choices?.length) {
      return result.choices[0].message.content || "Sorry, I have no response.";
    }
    return "No response from LLM.";
  } catch (err) {
    console.error("Error calling LLM with Groq:", err);
    return "Sorry, I'm having trouble generating a response right now.";
  }
}

// --------------------------------------------------------------------
// Fetch CSV and Ingest into Pinecone
// --------------------------------------------------------------------
async function fetchCsvLines(csvUrl: string): Promise<string[]> {
  const response = await fetch(csvUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch CSV from ${csvUrl}`);
  }
  const csv = await response.text();
  return csv
    .split("\n")
    .map((line) => line.trim())
    .filter((a) => a);
}

async function ingestCsvIntoPinecone(
  index: any,
  csvUrl: string,
  description: string,
  agentId: number
) {
  if (disableEmbeddings) {
    console.log("Embeddings are disabled; skipping CSV ingestion to Pinecone");
    return;
  }

  const lines = await fetchCsvLines(csvUrl);
  console.log("LINES", lines);
  const embeddings = await getHuggingFaceEmbeddings(lines);

  const vectors = lines.map((line, i) => ({
    id: `${agentId}-${Date.now()}-${i}`,
    values: embeddings[i],
    metadata: {
      source: csvUrl,
      description: description,
      content: line,
    },
  }));

  await index.upsert({ vectors });
}

// --------------------------------------------------------------------
// Agent Creation Route: /agent/create
// --------------------------------------------------------------------
interface KnowledgeDoc {
  type: string; // "csv", "pdf", etc.
  source: string; // URL or other location
  description: string;
}

interface WorkflowNode {
  id: string;
  description: string;
  nextNode?: string;
}

interface CreateAgentPayload {
  name: string;
  goal: string;
  domain: string;
  knowledge_docs: KnowledgeDoc[];
  tone: string;
  workflow: WorkflowNode[];
}

fastify.post(
  "/agent/create",
  async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as CreateAgentPayload;

      // 1. Insert agent into SQLite
      const result = await db.run(
        `INSERT INTO agents (name, goal, domain, tone) VALUES (?,?,?,?)`,
        [body.name, body.goal, body.domain, body.tone]
      );

      const agentId = result.lastID;

      // 2. Store the workflow in the workflows table as JSON
      const workflowJson = JSON.stringify(body.workflow);
      await db.run(
        `INSERT INTO workflows (agentId, workflowJson) VALUES (?,?)`,
        [agentId, workflowJson]
      );
      console.log("SQLITE SUCCESS");

      // 3. If embeddings are enabled, ingest knowledge docs into Pinecone
      const index = await initPinecone();
      if (index && !disableEmbeddings) {
        for (const doc of body.knowledge_docs) {
          if (doc.type === "csv") {
            await ingestCsvIntoPinecone(
              index,
              doc.source,
              doc.description,
              agentId
            );
          } else {
            console.log(`Skipping unsupported doc type: ${doc.type}`);
          }
        }
      } else {
        console.log("Embeddings disabled; skipping doc ingestion.");
      }

      reply.send({
        status: "success",
        message: "Agent created successfully",
        agentId,
      });
    } catch (error) {
      console.error("Error creating agent:", error);
      reply.status(500).send({
        status: "error",
        message: (error as Error).message,
      });
    }
  }
);

// --------------------------------------------------------------------
// Single Interaction Endpoint: /agent/:agentId/interact
// --------------------------------------------------------------------
async function getCurrentSession(sessionId: string, agentId: number) {
  const session = await db.get(
    `SELECT * FROM sessions WHERE sessionId = ? AND agentId = ?`,
    [sessionId, agentId]
  );

  // Create a new session if one doesn't exist
  if (!session) {
    const workflow = await db.get(
      `SELECT workflowJson FROM workflows WHERE agentId = ?`,
      [agentId]
    );

    if (!workflow) throw new Error(`Workflow not found for agent ${agentId}`);

    const parsedWorkflow = JSON.parse(workflow.workflowJson);
    // Use the first node in the workflow or default to "greet"
    const initialNode = parsedWorkflow[0]?.id || "greet";

    await db.run(
      `INSERT INTO sessions (sessionId, agentId, currentNode, context) VALUES (?, ?, ?, ?)`,
      [sessionId, agentId, initialNode, JSON.stringify({})]
    );

    return { sessionId, agentId, currentNode: initialNode, context: {} };
  }

  // Parse the context field into an object
  return {
    ...session,
    context: session.context ? JSON.parse(session.context) : {},
  };
}

async function updateSession(
  sessionId: string,
  agentId: number,
  nextNode: string,
  context: object
) {
  await db.run(
    `UPDATE sessions SET currentNode = ?, context = ? WHERE sessionId = ? AND agentId = ?`,
    [nextNode, JSON.stringify(context), sessionId, agentId]
  );
}

fastify.post(
  "/agent/:agentId/interact",
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { agentId } = request.params as { agentId: string };
    const { sessionId, input } = request.body as {
      sessionId: string;
      input: string;
    };

    try {
      const session = await getCurrentSession(sessionId, Number(agentId));
      const { currentNode, context } = session;

      // Grab the workflow for the agent
      const workflow = await db.get(
        `SELECT workflowJson FROM workflows WHERE agentId = ?`,
        [agentId]
      );
      if (!workflow) throw new Error(`Workflow not found for agent ${agentId}`);

      const parsedWorkflow = JSON.parse(workflow.workflowJson);
      const currentStep = parsedWorkflow.find(
        (node: any) => node.id === currentNode
      );

      if (!currentStep) {
        throw new Error(`Invalid workflow step: ${currentNode}`);
      }

      let responseMessage: string;
      // We'll pass "input" (the user's message) and some relevant context
      // to the LLM in every step. The only difference is how we set that context.

      switch (currentStep.id) {
        case "greet": {
          // Minimal context, just greet the user
          responseMessage = await generateLLMResponse(
            // userMessage
            input || "User arrived; greet them politely.",
            // context
            "The user has just started interaction. Provide a friendly greeting."
          );
          break;
        }

        case "collectInformation": {
          // Save user input in context
          context["userInfo"] = input;
          responseMessage = await generateLLMResponse(
            // userMessage
            `The user provided this info: "${input}". Acknowledge and confirm saving it.`,
            // context
            "We store user info in context for future steps."
          );
          break;
        }

        case "askQuestions": {
          // Possibly embed and query Pinecone
          let relevantContext =
            "No relevant context found (embeddings disabled).";

          if (!disableEmbeddings) {
            const embeddings = await getHuggingFaceEmbeddings([input]);
            const index = pinecone.Index(PINECONE_INDEX);
            const pineconeResults = await index.query({
              vector: embeddings[0],
              topK: 3,
              includeMetadata: true,
            });

            relevantContext = pineconeResults.matches
              .map((match: any) => match.metadata.content)
              .join("\n");
          }

          // Now pass user input + relevant context to the LLM
          responseMessage = await generateLLMResponse(input, relevantContext);
          break;
        }

        case "followUp": {
          // Possibly another LLM prompt for final text
          responseMessage = await generateLLMResponse(
            "Conclude the conversation by telling the user we've sent a follow-up email.",
            "No additional context required."
          );
          break;
        }

        default: {
          // Provide a fallback LLM-based response
          responseMessage = await generateLLMResponse(
            `The user is at unknown step: ${currentStep.id}`,
            "Workflow step is not recognized; provide a safe fallback answer."
          );
          break;
        }
      }

      // Move to the next step if specified
      const nextNode = currentStep.nextNode || null;
      if (nextNode) {
        await updateSession(sessionId, Number(agentId), nextNode, context);
      }

      reply.send({
        status: "success",
        message: responseMessage,
        nextNode,
        context,
      });
    } catch (error) {
      console.error("Error in interaction:", error);
      reply.status(500).send({
        status: "error",
        message: (error as Error).message,
      });
    }
  }
);

// --------------------------------------------------------------------
// Start the Server
// --------------------------------------------------------------------
async function startServer() {
  await initDB();

  try {
    await fastify.listen({ port: 3000 });
    console.log("Server is running on port 3000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

startServer().catch(console.error);
