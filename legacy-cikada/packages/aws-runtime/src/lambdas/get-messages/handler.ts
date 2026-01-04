/**
 * Get Messages Handler
 *
 * HTTP GET /thread/{threadId}/messages
 *
 * Returns all messages for a thread.
 */

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const getThreadsTable = () => process.env.THREADS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const threadId = event.pathParameters?.threadId;

  if (!threadId) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Missing threadId" }),
    };
  }

  console.log(`Getting messages for thread ${threadId}`);

  try {
    // Query messages by threadId (sorted by msgId which is ULID)
    const result = await docClient.send(
      new QueryCommand({
        TableName: getThreadsTable(),
        KeyConditionExpression: "threadId = :tid",
        ExpressionAttributeValues: {
          ":tid": threadId,
        },
      })
    );

    const messages = (result.Items ?? []).map((item) => ({
      msgId: item.msgId,
      threadId: item.threadId,
      value: item.value,
      createdAt: item.createdAt,
    }));

    console.log(`Found ${messages.length} messages for thread ${threadId}`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ messages }),
    };
  } catch (error) {
    console.error("Failed to get messages:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to get messages" }),
    };
  }
};
