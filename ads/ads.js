document.addEventListener("DOMContentLoaded", () => {
  const routes = {
    "/dashboard": AdsViews.dashboard,
    "/venues": AdsViews.venues,
    "/claim": AdsViews.claim,
    "/profile": AdsViews.profile,
    "/campaigns": AdsViews.campaigns,
    "/results": AdsViews.results,
  };

  AdsRouter.init(routes);
});
