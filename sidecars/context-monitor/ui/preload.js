(function() {
  window.addEventListener("message", function(event) {
    if (event.data && event.data.type === "theme-change" && event.data.payload && event.data.payload.cssVariables) {
      const vars = event.data.payload.cssVariables;
      for (const [k, v] of Object.entries(vars)) {
        document.documentElement.style.setProperty(k, v);
      }
    }
  });
})();
