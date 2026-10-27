// Public, committable defaults. Secrets (tokens) are NOT stored here —
// the token field in the page keeps them in the browser's localStorage only.
window.MG_CONFIG = {
  // Relative path works when nginx proxies /api/sam to the proxy server.
  // For direct testing you can put a full URL here instead.
  samEndpoint: "/api/sam",
  defaultPrompts: "door, steps",
  // Start in mock mode so the page works with no backend. Untick to call SAM.
  mockByDefault: true
};
