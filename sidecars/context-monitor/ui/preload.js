(function() {
  window.addEventListener("message", function(event) {
    if (event.data && event.data.type === "theme-change" && event.data.payload && event.data.payload.cssVariables) {
      const vars = event.data.payload.cssVariables;
      for (const [k, v] of Object.entries(vars)) {
        document.documentElement.style.setProperty(k, v);
      }
    }
  });

  if (!window.sidecar) {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") || "";
    const conversationId = params.get("conversationId") || "";
    let workspaceUris = [];

    window.addEventListener("message", function(event) {
      if (event.data && event.data.type === "workspace-change" && event.data.payload) {
        workspaceUris = Array.isArray(event.data.payload.workspaceUris)
          ? [...event.data.payload.workspaceUris]
          : [];
      }
    });

    window.sidecar = {
      conversationId,
      fetch: function(url, options) {
        const opts = options ? { ...options } : {};
        if (token) {
          const headers = new Headers(opts.headers || {});
          headers.set("X-Sidecar-Token", token);
          opts.headers = headers;
        }
        return window.fetch(url, opts);
      },
      getWorkspaceUris: async function() {
        return [...workspaceUris];
      },
      ui: {
        toggleAuxPane: function(request) {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: "toggle-aux-pane", payload: request }, "*");
          }
        },
        toggleConversation: function(convId, options) {
          if (window.parent && window.parent !== window) {
            const payload =
              options && typeof options === "object"
                ? { conversationId: convId, ...options }
                : { conversationId: convId };
            window.parent.postMessage({ type: "toggle-conversation", payload }, "*");
          }
        },
      },
    };
  }
})();
