import * as acp from "@agentclientprotocol/sdk";
import { CcAcpAgent, type HostLauncher } from "./agent.js";
import { launchHostSession } from "./host-session.js";

const { AGENT_METHODS, CLIENT_METHODS } = acp;

export function serveAgent(stream: acp.Stream, version: string, launch: HostLauncher = launchHostSession) {
  let agent: CcAcpAgent | undefined;
  const conn = acp
    .agent({ name: "cc-acp" })
    .onConnect((c) => {
      agent = new CcAcpAgent(
        {
          sessionUpdate: (p) => c.client.notify(CLIENT_METHODS.session_update, p),
          createElicitation: (p) => c.client.request(CLIENT_METHODS.elicitation_create, p),
          requestPermission: (p) => c.client.request(CLIENT_METHODS.session_request_permission, p),
        },
        version,
        launch,
      );
    })
    .onRequest(AGENT_METHODS.initialize, (ctx) => agent!.initialize(ctx.params))
    .onRequest(AGENT_METHODS.session_new, (ctx) => agent!.newSession(ctx.params))
    .onRequest(AGENT_METHODS.session_load, (ctx) => agent!.loadSession(ctx.params))
    .onRequest(AGENT_METHODS.session_list, (ctx) => agent!.listSessions(ctx.params))
    .onRequest(AGENT_METHODS.session_resume, (ctx) => agent!.resumeSession(ctx.params))
    .onRequest(AGENT_METHODS.session_close, (ctx) => agent!.closeSession(ctx.params))
    .onRequest(AGENT_METHODS.session_delete, (ctx) => agent!.deleteSession(ctx.params))
    .onRequest(AGENT_METHODS.session_fork, (ctx) => agent!.forkSession(ctx.params))
    .onRequest(AGENT_METHODS.authenticate, async () => (await agent!.authenticate(), {}))
    .onRequest(AGENT_METHODS.session_set_mode, async (ctx) => (await agent!.setSessionMode(ctx.params), {}))
    .onRequest(AGENT_METHODS.session_set_config_option, (ctx) => agent!.setSessionConfigOption(ctx.params))
    .onRequest(AGENT_METHODS.session_prompt, (ctx) => agent!.prompt(ctx.params, ctx.signal))
    .onRequest("_session/steering", (params) => params as Parameters<CcAcpAgent["steer"]>[0], (ctx) => agent!.steer(ctx.params))
    .onNotification(AGENT_METHODS.session_cancel, (ctx) => agent!.cancel(ctx.params))
    .connect(stream);
  return { closed: conn.closed, close: () => agent?.close() ?? Promise.resolve() };
}
