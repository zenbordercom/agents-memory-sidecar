import type { Actor, Role } from "./types.js";

const validRoles = new Set<Role>(["reader", "writer", "admin"]);

export function actorFromEnv(env: NodeJS.ProcessEnv = process.env): Actor {
  const role = env.AGENT_MEMORY_ROLE ?? "writer";
  if (!validRoles.has(role as Role)) {
    throw new Error(`Invalid AGENT_MEMORY_ROLE: ${role}`);
  }

  return {
    tenant: env.AGENT_MEMORY_TENANT ?? "default",
    agentId: env.AGENT_MEMORY_AGENT_ID ?? "local-agent",
    runtime: env.AGENT_MEMORY_RUNTIME ?? "local",
    workspace: env.AGENT_MEMORY_WORKSPACE ?? process.cwd(),
    role: role as Role,
    projects: (env.AGENT_MEMORY_PROJECTS ?? "*")
      .split(",")
      .map((project) => project.trim())
      .filter(Boolean),
  };
}

export function canRead(actor: Actor, tenant: string, project: string): boolean {
  return tenant === actor.tenant && projectAllowed(actor, project);
}

export function canWrite(actor: Actor, tenant: string, project: string): boolean {
  return actor.role !== "reader" && canRead(actor, tenant, project);
}

export function canAdmin(actor: Actor, tenant: string, project: string): boolean {
  return actor.role === "admin" && canRead(actor, tenant, project);
}

function projectAllowed(actor: Actor, project: string): boolean {
  return actor.projects.includes("*") || actor.projects.includes(project);
}
