// netlify/functions/health.js
export default async (request, context) => {
  return new Response(JSON.stringify({ ok: true, message: "Functions are working 🚀" }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
};