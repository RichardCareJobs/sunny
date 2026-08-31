/**
 * Runtime configuration.
 *
 * This file is committed on purpose, and the Supabase anon key in it is public
 * on purpose. It is the same key the consumer app ships in app.js, it is sent
 * to every browser that loads the site, and hiding it is neither possible nor
 * the point — row level security is what protects the data. The brief's "never
 * commit real keys" applies to the service role key, the Stripe secret key and
 * the Twilio auth token, none of which are here or anywhere else in this repo.
 * Those live only in Supabase Edge Function secrets. See .env.example.
 *
 * Committing this is what lets the app run end to end on a clean checkout with
 * no setup, which the brief asks for.
 */
(function () {
  var host = window.location.hostname;
  var stage =
    host === "venues.sunnypubs.app" ? "production" :
    host.endsWith("github.io") ? "staging" :
    "development";

  window.SUNNY_VENUES_CONFIG = Object.assign({
    supabaseUrl: "https://ivylljoqjswkuyrpevmg.supabase.co",
    supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2eWxsam9xanN3a3V5cnBldm1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4OTk4NzksImV4cCI6MjA4OTQ3NTg3OX0.nyRzoYBdJeMg2CR45WRR7bDMkHSi524z_dLfASIBczs",
    siteUrl: window.location.origin,
    stage: stage,
  }, window.SUNNY_VENUES_CONFIG || {});
})();
