const AdsRouter = (() => {
  let routes = {};
  let toastMessage = "";

  function parseHash() {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) {
      return { path: "/dashboard", query: {} };
    }
    const [pathPart, queryString] = hash.split("?");
    const path = pathPart || "/dashboard";
    const query = {};
    if (queryString) {
      const params = new URLSearchParams(queryString);
      params.forEach((value, key) => {
        query[key] = value;
      });
    }
    return { path, query };
  }

  function setToast(message) {
    toastMessage = message;
  }

  function consumeToast() {
    const message = toastMessage;
    toastMessage = "";
    return message;
  }

  function updateNav(path) {
    const links = document.querySelectorAll(".nav a[data-route]");
    links.forEach((link) => {
      if (link.dataset.route === path) {
        link.classList.add("active");
      } else {
        link.classList.remove("active");
      }
    });
  }

  function render() {
    const { path, query } = parseHash();
    const route = routes[path];
    if (!route) {
      window.location.hash = "#/dashboard";
      return;
    }
    updateNav(path);
    route({ path, query });
  }

  function init(routeMap) {
    routes = routeMap;
    window.addEventListener("hashchange", render);
    render();
  }

  function navigate(path) {
    window.location.hash = path;
  }

  return {
    init,
    navigate,
    setToast,
    consumeToast,
    parseHash,
  };
})();

window.AdsRouter = AdsRouter;
