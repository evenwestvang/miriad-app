/**
 * List Threads Handler
 *
 * HTTP GET /threads
 *
 * Returns all threads for display in the UI.
 * Note: In production, this would be filtered by user ID.
 */

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const getThreadMetaTable = () => process.env.THREAD_META_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async () => {
  console.log("Listing threads");

  try {
    // Scan all threads (in production, filter by userId)
    const result = await docClient.send(
      new ScanCommand({
        TableName: getThreadMetaTable(),
        // Only return non-archived threads
        FilterExpression: "attribute_not_exists(#archived) OR #archived = :false",
        ExpressionAttributeNames: {
          "#archived": "archived",
        },
        ExpressionAttributeValues: {
          ":false": false,
        },
      })
    );

    const threads = (result.Items ?? []).map((item) => ({
      threadId: item.threadId,
      agentName: item.agentName,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    // Sort by createdAt descending (newest first)
    threads.sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    console.log(`Found ${threads.length} threads`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ threads }),
    };
  } catch (error) {
    console.error("Failed to list threads:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to list threads" }),
    };
  }
};
