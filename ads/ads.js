document.addEventListener("DOMContentLoaded", () => {
  const state = AdsState.loadState();
  const params = new URLSearchParams(window.location.search);
  let shouldSave = false;
  if (params.get("admin") === "1" && !state.adminMode) {
    state.adminMode = true;
    shouldSave = true;
  }
  if (shouldSave) {
    AdsState.saveState(state);
  }

  const nav = document.querySelector(".nav");
  if (nav) {
    const existing = nav.querySelector('a[data-route="/admin"]');
    if (state.adminMode && !existing) {
      const link = document.createElement("a");
      link.href = "#/admin";
      link.dataset.route = "/admin";
      link.textContent = "Admin";
      nav.appendChild(link);
    }
    if (!state.adminMode && existing) {
      existing.remove();
    }
  }

  const routes = {
    "/dashboard": AdsViews.dashboard,
    "/venues": AdsViews.venues,
    "/claim": AdsViews.claim,
    "/profile": AdsViews.profile,
    "/campaigns": AdsViews.campaigns,
    "/results": AdsViews.results,
    "/admin": AdsViews.admin,
  };

  AdsRouter.init(routes);
});
