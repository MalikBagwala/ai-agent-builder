import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors"; // Import CORS middleware

const app = express();

// Enable CORS
app.use(cors());

// Parse incoming JSON requests
app.use(bodyParser.json());

// ---------------------------
// 1) Types and In-Memory "Database"
// ---------------------------

interface UserSession {
  userData: Record<string, any>;
  state: string | null;
  conversationHistory: Array<{
    user: string;
    system: string;
    state: string | null;
  }>;
}

interface LeadData {
  name: string;
  needs: string;
  followupInfo: string;
  savedAt: string;
}

interface KnowledgeBaseEntry {
  keywords: string[];
  content: string;
}

interface ConversationNode {
  systemInstructions: string;
  next: string | null;
}

interface ConversationGraph {
  startNode: string;
  nodes: Record<string, ConversationNode>;
}

interface FunctionCall {
  name: string;
  arguments: Record<string, any>;
}

let userSessions: Record<string, UserSession> = {};
let leadData: LeadData[] = [];

// ---------------------------
// 2) Naive Knowledge Base for RAG
// ---------------------------

const knowledgeBase: KnowledgeBaseEntry[] = [
  {
    keywords: ["pricing", "cost", "price"],
    content: "Our product is priced at $99/month for the basic plan.",
  },
  {
    keywords: ["features", "capabilities"],
    content:
      "Our solution includes advanced analytics, user management, and 24/7 customer support.",
  },
  {
    keywords: ["shipping", "delivery"],
    content:
      "We offer free standard shipping worldwide. Expedited shipping is available at an extra cost.",
  },
];

function retrieveRelevantInfo(userMessage: string): string[] {
  const lowerMessage = userMessage.toLowerCase();
  const foundMatches: string[] = [];
  for (const entry of knowledgeBase) {
    for (const kw of entry.keywords) {
      if (lowerMessage.includes(kw)) {
        foundMatches.push(entry.content);
        break;
      }
    }
  }
  return foundMatches;
}

// ---------------------------
// 3) Conversation Graph
// ---------------------------

let conversationGraph: ConversationGraph = {
  startNode: "intro",
  nodes: {
    intro: {
      systemInstructions: `
        You are a helpful Sales Agent. 
        Greet the user and introduce yourself. 
        Then transition to 'collectName'.
      `,
      next: "collectName",
    },
    collectName: {
      systemInstructions: `
        Ask the user for their name. 
        Wait for user response, then store it. 
        Once name is collected, transition to 'collectNeeds'.
      `,
      next: "collectNeeds",
    },
    collectNeeds: {
      systemInstructions: `
        Ask the user about their main needs or interests regarding the product. 
        Wait for user response, then store it. 
        If user has product questions, answer them using RAG. 
        Then transition to 'offerFollowUp'.
      `,
      next: "offerFollowUp",
    },
    offerFollowUp: {
      systemInstructions: `
        Offer to schedule a follow-up call or provide additional info. 
        If user agrees, call function 'saveLeadData'. 
        Then transition to 'farewell'.
      `,
      next: "farewell",
    },
    farewell: {
      systemInstructions: `
        Thank the user for chatting. 
        End the conversation gracefully.
      `,
      next: null,
    },
  },
};

// ---------------------------
// 4) Orchestrating LLM + Graph
// ---------------------------

async function fakeLLMCall(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  if (userMessage.includes("call function: saveLeadData")) {
    return JSON.stringify({
      functionCall: {
        name: "saveLeadData",
        arguments: {
          info: "User is interested in scheduling a follow-up.",
        },
      },
    });
  }

  return `LLM Response: (Pretend I'm an advanced model) - 
  System says: "${systemPrompt.trim()}"
  User says: "${userMessage.trim()}"

  (Response in plain text. This is a placeholder LLM response.)
  `;
}

async function handleConversation(
  sessionId: string,
  userMessage: string
): Promise<{
  reply: string;
  nextState: string | null;
  end: boolean;
}> {
  const session = userSessions[sessionId] || {
    userData: {},
    state: conversationGraph.startNode,
    conversationHistory: [],
  };

  const currentNode =
    session.state && conversationGraph.nodes[session.state]
      ? conversationGraph.nodes[session.state]
      : conversationGraph.nodes[conversationGraph.startNode];

  if (!currentNode) {
    return {
      reply: "Conversation flow not found.",
      end: true,
      nextState: null,
    };
  }

  const ragResults = retrieveRelevantInfo(userMessage);
  const contextSection = ragResults.length
    ? `\nRelevant info:\n${ragResults.join("\n")}`
    : "";

  const systemPrompt = `
    ${currentNode.systemInstructions}
    ${contextSection}
  `;

  const llmResponseRaw = await fakeLLMCall(systemPrompt, userMessage);

  let functionCall: FunctionCall | null = null;
  try {
    const parsed = JSON.parse(llmResponseRaw);
    if (parsed.functionCall) {
      functionCall = parsed.functionCall;
    }
  } catch (err) {}

  let finalReply = llmResponseRaw;

  if (functionCall && functionCall.name === "saveLeadData") {
    saveLeadData(sessionId, (functionCall as any).arguments);
    finalReply = "Your information has been saved! Thank you.";
  }

  if (session.state === "collectName") {
    session.userData.name = userMessage;
  } else if (session.state === "collectNeeds") {
    session.userData.needs = userMessage;
  }

  const nextNodeKey = currentNode.next;
  session.state = nextNodeKey || null;

  session.conversationHistory.push({
    user: userMessage,
    system: finalReply,
    state: session.state,
  });

  userSessions[sessionId] = session;

  return {
    reply: finalReply,
    nextState: session.state,
    end: !session.state,
  };
}

function saveLeadData(sessionId: string, { info }: { info: string }) {
  const session: any = userSessions[sessionId] || {};
  const dataToSave: LeadData = {
    name: session.userData.name || "Unknown",
    needs: session.userData.needs || "N/A",
    followupInfo: info,
    savedAt: new Date().toISOString(),
  };
  leadData.push(dataToSave);
}

// ---------------------------
// 5) API Endpoints
// ---------------------------

app.post("/api/agent/define", (req: Request, res: Response) => {
  const { graph } = req.body;
  if (!graph) {
    return res.status(400).json({ error: "Graph data required" });
  }
  conversationGraph = graph;
  return res.json({ message: "Conversation graph updated." });
});

app.get("/api/agent/graph", (req: Request, res: Response) => {
  return res.json({ graph: conversationGraph });
});

app.post("/api/agent/message", async (req: Request, res: Response) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res
      .status(400)
      .json({ error: "sessionId and message are required." });
  }

  const result = await handleConversation(sessionId, message);

  res.json({
    reply: result.reply,
    nextState: result.nextState,
    conversationEnded: result.end,
  });
});

app.get("/api/leads", (req: Request, res: Response) => {
  return res.json({ leads: leadData });
});

// ---------------------------
// Start Server
// ---------------------------

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`AI Agent Builder running on http://localhost:${PORT}`);
});
