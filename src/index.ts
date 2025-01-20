import Fastify from "fastify";
const fastify = Fastify({
  logger: true,
});
import Groq from "groq-sdk";

// Declare a route
fastify.get("/", async function handler(request, reply) {
  return { hello: "world" };
});

// Run the server!
try {
  await fastify.listen({ port: 3000 });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
