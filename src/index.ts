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
        Greet the user warmly and introduce yourself as "I am a Sales Agent here to assist you." 
        Ask the user for their name (e.g., "May I know your name, please?"). 
        Once the user responds, transition to 'collectName'.
      `,
      next: "collectName",
    },
    collectName: {
      systemInstructions: `
        Confirm the user's name (e.g., "Nice to meet you, [name]!"). 
        Politely ask them about their main needs or interests regarding the product 
        (e.g., "What brings you here today? What are you looking for?"). 
        Once the user responds, transition to 'collectNeeds'.
      `,
      next: "collectNeeds",
    },
    collectNeeds: {
      systemInstructions: `
        Listen to the user's main needs or interests and store their response. 
        If the user asks questions about the product, provide helpful answers using RAG. 
        After addressing their needs or questions, politely ask if they'd like to schedule a follow-up call 
        or receive additional details. 
        Transition to 'offerFollowUp'.
      `,
      next: "offerFollowUp",
    },
    offerFollowUp: {
      systemInstructions: `
        Offer to schedule a follow-up call or send additional information (e.g., "Would you like me to schedule 
        a follow-up call or send more details to your email?"). 
        If the user agrees, call the function 'saveLeadData' to store their information. 
        Once the action is completed, thank them for their time and transition to 'farewell'.
      `,
      next: "farewell",
    },
    farewell: {
      systemInstructions: `
        Thank the user for chatting (e.g., "Thank you for your time, [name]! If you have any further questions, feel free to reach out."). 
        End the conversation gracefully.
      `,
      next: null,
    },
  },
};

// ---------------------------
// 4) Orchestrating LLM + Graph
// ---------------------------

async function llmCall(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  // Combine the system instructions and user message into a single prompt
  const fullPrompt = `Conversation Graph: ${JSON.stringify(conversationGraph)}
System Instructions:
${systemPrompt.trim()}
User:
${userMessage.trim()}
Assistant:
  `;

  try {
    const response = await fetch("http://127.0.0.1:1234/v1/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: fullPrompt,
        temperature: 0.4,
        max_tokens: 30,
        stream: false,
        stop: ["Answer:", "\n"],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed with status: ${response.status}`);
    }

    const data = await response.json();

    // Extract and return the generated text
    const generatedText = (data as any)?.choices?.[0]?.text?.trim() || "";
    return generatedText;
  } catch (error) {
    console.error("Error calling LLM:", error);
    return "I'm sorry, something went wrong while generating a response.";
  }
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

  const llmResponseRaw = await llmCall(systemPrompt, userMessage);

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

  console.log(JSON.stringify(userSessions), "SESSIONS");
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
