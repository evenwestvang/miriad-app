import "dotenv/config";
import { defineAgent, defineWorkflow, defineTool } from "@cikada/agent";
import { createServer } from "@cikada/local-runtime";
import { z } from "zod";

// =============================================================================
// Simple Assistant - No tools, just conversation
// =============================================================================

const simpleAssistant = defineAgent({
  name: "simple",
  system: "You are a helpful assistant. Be concise and friendly.",
});

// =============================================================================
// Weather Assistant - With tools
// =============================================================================

const weatherAssistant = defineAgent({
  name: "weather",
  system: `You help users check the weather. Always be concise.
When asked about weather, use the get_weather tool to fetch current conditions.
When asked about forecasts, use the get_forecast tool.`,

  tools: {
    get_weather: defineTool({
      description: "Get current weather for a location",
      parameters: z.object({
        location: z.string().describe("City name, e.g., 'San Francisco'"),
      }),
      execute: async ({ location }) => {
        // location is typed as string - no cast needed!
        console.log(`[Tool] Getting weather for ${location}`);
        return {
          location,
          temperature: Math.round(15 + Math.random() * 15),
          conditions: ["Sunny", "Partly cloudy", "Cloudy", "Rainy"][
            Math.floor(Math.random() * 4)
          ],
          humidity: Math.round(40 + Math.random() * 40),
          wind: Math.round(5 + Math.random() * 20),
        };
      },
    }),

    get_forecast: defineTool({
      description: "Get weather forecast for the next few days",
      parameters: z.object({
        location: z.string().describe("City name"),
        days: z.number().min(1).max(7).optional().describe("Number of days (default: 3)"),
      }),
      execute: async ({ location, days = 3 }) => {
        // location is string, days defaults to 3
        console.log(`[Tool] Getting ${days}-day forecast for ${location}`);
        return {
          location,
          forecast: Array.from({ length: days }, (_, i) => ({
            day: i + 1,
            high: Math.round(20 + Math.random() * 10),
            low: Math.round(10 + Math.random() * 5),
            conditions: ["Sunny", "Partly cloudy", "Cloudy", "Rainy"][
              Math.floor(Math.random() * 4)
            ],
          })),
        };
      },
    }),
  },
});

// =============================================================================
// Calculator Assistant - Multiple tools
// =============================================================================

const calculatorAssistant = defineAgent({
  name: "calculator",
  system: `You are a calculator assistant. Help users with math calculations.
Use the available tools to perform calculations. Show your work.`,

  tools: {
    add: defineTool({
      description: "Add two numbers",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      execute: async ({ a, b }) => {
        console.log(`[Tool] Adding ${a} + ${b}`);
        return { result: a + b, operation: `${a} + ${b}` };
      },
    }),

    multiply: defineTool({
      description: "Multiply two numbers",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      execute: async ({ a, b }) => {
        console.log(`[Tool] Multiplying ${a} × ${b}`);
        return { result: a * b, operation: `${a} × ${b}` };
      },
    }),

    divide: defineTool({
      description: "Divide two numbers",
      parameters: z.object({
        a: z.number().describe("Dividend"),
        b: z.number().describe("Divisor"),
      }),
      execute: async ({ a, b }) => {
        console.log(`[Tool] Dividing ${a} ÷ ${b}`);
        if (b === 0) {
          return { error: "Cannot divide by zero" };
        }
        return { result: a / b, operation: `${a} ÷ ${b}` };
      },
    }),

    power: defineTool({
      description: "Raise a number to a power",
      parameters: z.object({
        base: z.number().describe("Base number"),
        exponent: z.number().describe("Exponent"),
      }),
      execute: async ({ base, exponent }) => {
        console.log(`[Tool] Computing ${base}^${exponent}`);
        return {
          result: Math.pow(base, exponent),
          operation: `${base}^${exponent}`,
        };
      },
    }),
  },
});

// =============================================================================
// Custom Event Handler - onEvent mode
// =============================================================================

const customEventAgent = defineAgent({
  name: "event-handler",
  system: "You are a custom assistant that tracks message counts.",

  async onEvent(event, ctx) {
    if (event.type === "message") {
      console.log(`[onEvent] Received message: ${event.content}`);

      // Use ctx.message() for custom streaming control
      const msg = ctx.message({ type: "assistant" });
      await msg.stream("I received your message: ");
      await msg.stream(`"${event.content}"`);
      await msg.stream("\n\nLet me think about that...");

      // Use ctx.step() for checkpointed operations
      const thoughtResult = await ctx.step("think", async () => {
        // Simulate thinking
        await new Promise((r) => setTimeout(r, 500));
        return { thought: "This is interesting!" };
      });

      await msg.stream(`\n\n${thoughtResult.thought}`);
      await msg.set({ type: "assistant", content: `I received: "${event.content}". ${thoughtResult.thought}` });
    }
  },
});

// =============================================================================
// Structured Flow - Workflow mode (uses onFlow, completes with result)
// =============================================================================

const onboardingWorkflow = defineWorkflow({
  name: "onboarding",
  system: "You guide users through a simple onboarding flow.",

  async onFlow(ctx) {
    console.log("[onFlow] Starting onboarding workflow");

    // Stage 1: Wait for first message
    const firstEvent = await ctx.events.next();
    console.log(`[onFlow] First event: ${firstEvent.type}`);

    // Greet the user
    await ctx.llm.generate("Welcome! I'll help you get started. What's your name?");

    // Stage 2: Get name
    const nameEvent = await ctx.events.next();
    const name = nameEvent.type === "message" ? nameEvent.content : "friend";
    console.log(`[onFlow] Got name: ${name}`);

    // Stage 3: Ask about interests
    await ctx.llm.generate(`Nice to meet you, ${name}! What are you interested in learning about?`);

    // Stage 4: Get interest
    const interestEvent = await ctx.events.next();
    const interest = interestEvent.type === "message" ? interestEvent.content : "general topics";
    console.log(`[onFlow] Got interest: ${interest}`);

    // Stage 5: Complete onboarding
    await ctx.llm.generate(
      `Great choice, ${name}! I'd love to help you learn about ${interest}. ` +
      `You're all set up now. Feel free to ask me anything!`
    );

    // Return result - workflow completes and sends thread_complete message
    return { name, interest, completed: true };
  },
});

// =============================================================================
// Start Server
// =============================================================================

const server = createServer({
  agents: {
    simple: simpleAssistant,
    weather: weatherAssistant,
    calculator: calculatorAssistant,
    "event-handler": customEventAgent,
    onboarding: onboardingWorkflow,
  },
  port: 3003,
});

server.start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

// Handle shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  process.exit(0);
});
