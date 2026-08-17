import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "open-agent-test-server", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, {
      tools: [
        {
          name: "read_fixture",
          description: "Read a fixture",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "write_marker",
          description: "Write a harmless marker file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, contents: { type: "string" } },
            required: ["path", "contents"],
          },
        },
      ],
    });
  } else if (message.method === "tools/call") {
    if (message.params.name === "read_fixture") {
      reply(message.id, { content: [{ type: "text", text: "fixture-read-ok" }] });
    } else if (message.params.name === "write_marker") {
      await writeFile(message.params.arguments.path, message.params.arguments.contents, "utf8");
      reply(message.id, { content: [{ type: "text", text: "marker-written" }] });
    }
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
