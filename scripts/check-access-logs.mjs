import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import morgan from "morgan";
import "./safe-access-log.mjs";

// Real HTTP requests through the same logger used by react-router-serve. No external I/O.
const lines = [];
const logger = morgan("tiny", { stream: { write: (line) => lines.push(line) } });
const server = createServer((request, response) => {
  logger(request, response, () => { response.statusCode = 204; response.end(); });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const queries = [
    "/app?shop=demo.myshopify.com&id_token=SECRET_SESSION&hmac=SECRET_SIGNATURE&session=SECRET_ID",
    "/paypal/return?token=SECRET_ORDER&PayerID=SECRET_PAYER",
    "/healthz?unexpected=SECRET_FUTURE_PARAMETER",
  ];
  for (const path of queries) assert.equal((await fetch(origin + path)).status, 204);
  assert.equal(lines.length, queries.length);
  for (const [index, line] of lines.entries()) {
    assert.ok(line.startsWith(`GET ${queries[index].split("?")[0]} 204 `), line);
    assert.ok(!line.includes("?") && !line.includes("SECRET_"), "Access log exposed query data");
  }
  console.log("PASS real HTTP access logs preserve method/path/status and omit every query parameter");
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
