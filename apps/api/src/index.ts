import { Hono } from "hono";
import adminApi from "./admin";
import { runNotificationTick } from "./notifications";
import pingApi from "./ping";
import readApi from "./read";
import { runScheduleTick } from "./scheduler";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (context) => context.json({ ok: true, service: "restic-monitor" }));
app.route("/api/v1/admin", adminApi);
app.route("/api/v1/ping", pingApi);
app.route("/api/v1/read", readApi);
app.notFound((context) => context.json({ error: "not_found" }, 404));

export default {
  fetch: (request: Request, env: Env, context: ExecutionContext) => app.fetch(request, env, context),
  scheduled: async (
    _controller: ScheduledController,
    env: Env,
    _context: ExecutionContext,
  ) => {
    await runScheduleTick(env.DB, Date.now());
    await runNotificationTick(env.DB, Date.now());
  },
};
