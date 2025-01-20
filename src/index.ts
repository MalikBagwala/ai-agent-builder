/***************************************************************************
 * agentBuilder.ts
 ***************************************************************************/

import { Pinecone } from "@pinecone-database/pinecone";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import fetch from "node-fetch";
import OpenAI from "openai";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

const fastify = Fastify({
  logger: true,
});

// --------------------------------------------------------------------
// 2. Initialize SQLite Database
//    - We'll create or open the local DB file named "agentDatabase.db"
//    - We'll make sure our tables exist for storing agents & workflows.
// --------------------------------------------------------------------
let db: any; // We will open it in an async function below

async function initDB() {
  db = await open({
    filename: "./agentDatabase.db",
    driver: sqlite3.Database,
  });

  // Create Agents table if not exists
  await db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      domain TEXT NOT NULL,
      tone TEXT NOT NULL
    );
  `);

  // Create Workflow table if not exists
  // For simplicity, storing each workflow node as a JSON string
  await db.run(`
    CREATE TABLE IF NOT EXISTS workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId INTEGER NOT NULL,
      workflowJson TEXT NOT NULL,
      FOREIGN KEY (agentId) REFERENCES agents(id)
    );
  `);

  // Create a table to store user data or conversation info if needed
  // We'll just show an example "long_term_data" table:
  await db.run(`
    CREATE TABLE IF NOT EXISTS long_term_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (agentId) REFERENCES agents(id)
    );
  `);
}

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = "agent-knowledge-index";

const pinecone = new Pinecone({
  apiKey: PINECONE_API_KEY,
});

async function initPinecone() {
  // Ensure the index is created or accessible
  // If the index doesn't exist, you'd create it in Pinecone’s dashboard or via their API
  // Here we just retrieve it:
  return pinecone.Index(PINECONE_INDEX);
}

// --------------------------------------------------------------------
// 4. Initialize OpenAI (for text embedding, etc.)
// --------------------------------------------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// --------------------------------------------------------------------
// 5. Utility: Fetch CSV from URL and parse into lines
//    - You can replace this with a more robust CSV parser if needed
// --------------------------------------------------------------------
async function fetchCsvLines(csvUrl: string): Promise<string[]> {
  const response = await fetch(csvUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch CSV from ${csvUrl}`);
  }
  const csv = await response.text();
  // Simple line-based splitting
  const lines = csv
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines;
}

// --------------------------------------------------------------------
// 6. Utility: Convert text to embeddings using OpenAI
// --------------------------------------------------------------------
async function getEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    const response = await client.embeddings.create({
      model: "text-embedding-ada-002",
      input: texts,
    });

    return response.data.map((item) => item.embedding);
  } catch (err) {
    console.error("Error creating embeddings", err);
    throw err;
  }
}

// --------------------------------------------------------------------
// 7. Ingest CSV docs into Pinecone
//    - Each row (line) in the CSV is embedded and stored
// --------------------------------------------------------------------
async function ingestCsvIntoPinecone(
  index: any,
  csvUrl: string,
  description: string,
  agentId: number
) {
  // Step 1: Fetch lines from CSV
  const lines = await fetchCsvLines(csvUrl);

  // Step 2: Create embeddings
  const embeddings = await getEmbeddings(lines);

  const vectors = lines.map((line, i) => ({
    id: `${agentId}-${Date.now()}-${i}`,
    values: embeddings[i],
    metadata: {
      source: csvUrl,
      description: description,
      content: line,
    },
  }));

  // Pinecone upsert
  await index.upsert({ upsertRequest: { vectors } });
}

// --------------------------------------------------------------------
// 8. Route: /agent/create
//    - Creates an agent record in SQLite
//    - Ingests knowledge docs (CSVs) into Pinecone
//    - Stores the workflow in SQLite
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
  async function handler(request: FastifyRequest, reply: FastifyReply) {
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

      // 3. Ingest each knowledge doc into Pinecone
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
          // Extend logic for PDF or other doc types as needed
          console.log(`Skipping doc type ${doc.type} for now.`);
        }
      }

      // 4. Return success
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
// 9. (Optional) Example of storing “long-term data” in SQLite
//    You can create additional routes to store user info or conversation logs.
// --------------------------------------------------------------------
fastify.post(
  "/agent/:agentId/storeLongTermData",
  async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const agentId = Number((request.params as { agentId: string }).agentId);
      const { data } = request.body as { data: string };

      await db.run(`INSERT INTO long_term_data (agentId, data) VALUES (?, ?)`, [
        agentId,
        data,
      ]);

      reply.send({
        status: "success",
        message: "Data stored successfully",
      });
    } catch (error) {
      console.error("Error storing data:", error);
      reply.status(500).send({
        status: "error",
        message: (error as Error).message,
      });
    }
  }
);

// --------------------------------------------------------------------
// 10. Example “function call” stubs
//     In a real AI agent system, you might define endpoints for each
//     node in the workflow (like greet, collect info, etc.).
// --------------------------------------------------------------------

// Example: greet user
fastify.post(
  "/agent/:agentId/greet",
  async (request: FastifyRequest, reply: FastifyReply) => {
    // In a real scenario, you might track conversation state, etc.
    return reply.send({ message: "Hello! How can I help you today?" });
  }
);

// Example: collect information
fastify.post(
  "/agent/:agentId/collectInformation",
  async (request: FastifyRequest, reply: FastifyReply) => {
    // Store user info in DB if needed
    // e.g. name, mobile, email...
    // For demonstration, just returning a stub
    return reply.send({
      message: "Please provide your name, mobile number, and email.",
    });
  }
);

// And so on for the other workflow steps...

// --------------------------------------------------------------------
// 11. Start the server
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
