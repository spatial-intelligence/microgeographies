// Public, committable defaults. Secrets (tokens) are NOT stored here —
// the token field in the page keeps them in the browser's localStorage only.
window.MG_CONFIG = {
  // Meta Responses API. Direct browser calls may be blocked by CORS —
  // if so, use "/api/sam" with server/proxy.mjs forwarding to this URL.
  samEndpoint: "https://api.meta.ai/v1/responses",
  // Model id for SAM 3.1 on the Meta API. Correct it here if the
  // catalogue names it differently.
  metaModel: "sam-3.1",
  defaultPrompts: "door, steps"
};
