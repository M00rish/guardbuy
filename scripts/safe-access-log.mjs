import morgan from "morgan";

// The stock server's access logger includes originalUrl, which contains embedded Shopify
// session tokens and PayPal return parameters. Register before the server imports Morgan.
morgan.token("url", (request) => {
  try {
    return new URL(request.originalUrl || request.url || "/", "http://localhost").pathname;
  } catch {
    return "[invalid-path]";
  }
});
