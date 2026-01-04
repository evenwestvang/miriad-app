/**
 * Multi-agent simulation script
 *
 * This script simulates multiple agents exchanging messages in a topic.
 * It uses the REST API to interact with the server (for simplicity).
 *
 * Run the server first: npm run server
 * Then run this: npm run simulate
 */

const BASE_URL = process.env.SERVER_URL || "http://localhost:3131";

interface Agent {
  name: string;
  description: string;
  topic: string;
}

async function apiCall(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

async function joinTopic(agent: Agent): Promise<void> {
  const result = await apiCall("POST", `/api/topics/${agent.topic}/join`, {
    name: agent.name,
    description: agent.description,
  });
  console.log(`[${agent.name}] Joined topic "${agent.topic}":`, result);
}

async function sendMessage(agent: Agent, content: string): Promise<void> {
  const result = await apiCall("POST", `/api/topics/${agent.topic}/messages`, {
    sender: agent.name,
    content,
  });
  console.log(`[${agent.name}] Sent message:`, content);
}

async function sendStatus(agent: Agent, status: string): Promise<void> {
  const result = await apiCall("POST", `/api/topics/${agent.topic}/status`, {
    sender: agent.name,
    status,
  });
  console.log(`[${agent.name}] Status:`, status);
}

async function getMessages(topic: string): Promise<unknown[]> {
  const result = await apiCall("GET", `/api/topics/${topic}/messages`);
  return result as unknown[];
}

async function getParticipants(topic: string): Promise<unknown[]> {
  const result = await apiCall("GET", `/api/topics/${topic}/participants`);
  return result as unknown[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSimulation() {
  console.log("Starting multi-agent simulation...\n");

  const topic = "feature-auth";

  // Define agents
  const agents: Agent[] = [
    {
      name: "frontend-agent",
      description: "Handles UI components and React code",
      topic,
    },
    {
      name: "backend-agent",
      description: "Handles API endpoints and database",
      topic,
    },
    {
      name: "test-agent",
      description: "Writes and runs tests",
      topic,
    },
  ];

  // All agents join the topic
  console.log("=== Agents joining topic ===\n");
  for (const agent of agents) {
    await joinTopic(agent);
    await sleep(100);
  }

  console.log("\n=== Current participants ===\n");
  const participants = await getParticipants(topic);
  console.log(participants);

  // Simulate a conversation
  console.log("\n=== Starting conversation ===\n");

  await sendStatus(agents[0], "analyzing requirements");
  await sleep(200);

  await sendMessage(
    agents[0],
    "I'll need to create a login form component. @backend-agent what endpoints should I call?"
  );
  await sleep(300);

  await sendStatus(agents[1], "thinking");
  await sleep(200);

  await sendMessage(
    agents[1],
    "I'll set up POST /api/auth/login and POST /api/auth/register. Will return JWT tokens."
  );
  await sleep(300);

  await sendMessage(
    agents[2],
    "@frontend-agent @backend-agent I'll write integration tests for the auth flow once you're ready."
  );
  await sleep(200);

  await sendStatus(agents[0], "implementing LoginForm.tsx");
  await sleep(500);

  await sendMessage(
    agents[0],
    "LoginForm component done. It handles email/password input and calls the login endpoint."
  );
  await sleep(200);

  await sendStatus(agents[1], "implementing auth routes");
  await sleep(400);

  await sendMessage(
    agents[1],
    "Auth endpoints ready. Using bcrypt for password hashing and JWT for tokens. @test-agent you can start testing."
  );
  await sleep(200);

  await sendStatus(agents[2], "writing tests");
  await sleep(300);

  await sendMessage(
    agents[2],
    "Added tests for: login success, login failure (wrong password), registration, and token validation. All passing!"
  );

  // Show final state
  console.log("\n=== Final messages in topic ===\n");
  const messages = await getMessages(topic);
  console.log(JSON.stringify(messages, null, 2));

  console.log("\n=== Simulation complete ===");
}

// Check if server is running
async function checkServer(): Promise<boolean> {
  try {
    await fetch(`${BASE_URL}/api/topics`);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const serverRunning = await checkServer();
  if (!serverRunning) {
    console.error(
      `Error: Server not running at ${BASE_URL}\nStart the server first with: npm run server`
    );
    process.exit(1);
  }

  await runSimulation();
}

main().catch(console.error);
