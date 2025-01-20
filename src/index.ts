import { Pinecone } from "@pinecone-database/pinecone";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import fetch from "node-fetch";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { Groq } from "groq-sdk";

const fastify = Fastify({
  logger: true,
});

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
// Pinecone Initialization
// --------------------------------------------------------------------
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = "agent-knowledge-index";

const pinecone = new Pinecone({
  apiKey: PINECONE_API_KEY,
});

async function initPinecone() {
  return pinecone.Index(PINECONE_INDEX);
}

// --------------------------------------------------------------------
// Groq SDK Initialization
// --------------------------------------------------------------------
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function getGroqEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    const response = await groq.embeddings.create({
      model: "nomic-embed-text-v1_5",
      input: texts,
    });

    // Assuming the response structure contains embeddings in 'data'
    return response.data.map((embedding: any) => embedding.embedding);
  } catch (error) {
    console.error("Error generating embeddings:", error);
    throw error;
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
    .filter(Boolean);
}

async function ingestCsvIntoPinecone(
  index: any,
  csvUrl: string,
  description: string,
  agentId: number
) {
  const lines = await fetchCsvLines(csvUrl);
  const embeddings = await getGroqEmbeddings(lines);

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

      // 3. Ingest knowledge docs into Pinecone
      const index = await initPinecone();

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

  if (!session) {
    const workflow = await db.get(
      `SELECT workflowJson FROM workflows WHERE agentId = ?`,
      [agentId]
    );

    if (!workflow) throw new Error(`Workflow not found for agent ${agentId}`);

    const parsedWorkflow = JSON.parse(workflow.workflowJson);
    const initialNode = parsedWorkflow[0]?.id;

    await db.run(
      `INSERT INTO sessions (sessionId, agentId, currentNode) VALUES (?, ?, ?)`,
      [sessionId, agentId, initialNode]
    );

    return { sessionId, agentId, currentNode: initialNode, context: {} };
  }

  return session;
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

      const workflow = await db.get(
        `SELECT workflowJson FROM workflows WHERE agentId = ?`,
        [agentId]
      );

      if (!workflow) throw new Error(`Workflow not found for agent ${agentId}`);

      const parsedWorkflow = JSON.parse(workflow.workflowJson);
      const currentStep = parsedWorkflow.find(
        (node: any) => node.id === currentNode
      );

      if (!currentStep)
        throw new Error(`Invalid workflow step: ${currentNode}`);

      let responseMessage: string;

      switch (currentStep.id) {
        case "greet":
          responseMessage = "Hello! How can I assist you today?";
          break;

        case "collectInformation":
          context["userInfo"] = input;
          responseMessage = "Thank you! Your information has been saved.";
          break;

        case "askQuestions":
          const embeddings = await getGroqEmbeddings([input]);
          const index = pinecone.Index(PINECONE_INDEX);
          const pineconeResults = await index.query({
            vector: embeddings[0],
            topK: 3,
            includeMetadata: true,
          });

          responseMessage = `Here’s what I found: ${pineconeResults.matches
            .map((match: any) => match.metadata.content)
            .join(", ")}`;
          break;

        case "followUp":
          responseMessage = "I’ve sent a follow-up email to your address.";
          break;

        default:
          responseMessage = "I’m not sure how to proceed.";
      }

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
