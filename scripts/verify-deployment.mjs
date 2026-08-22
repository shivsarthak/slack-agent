import { execa } from "execa";

const mode = process.argv[2];
const { stdout } = await execa("docker", [
  "compose",
  "-f",
  "compose.yaml",
  "config",
  "--format",
  "json",
]);
const compose = JSON.parse(stdout);
const services = compose.services;

const fail = (message) => {
  throw new Error(`[deployment:${mode}] ${message}`);
};
const mounts = (service) => services[service]?.volumes ?? [];

if (mode === "health") {
  for (const service of [
    "caddy",
    "control-plane",
    "postgres",
    "object-storage",
    "mail-sink",
    "worker-launcher",
    "worker",
  ])
    if (!services[service]?.healthcheck) fail(`${service} has no health check`);
} else if (mode === "migration") {
  if (services.migrate?.restart !== "no") fail("migration must be one-shot");
  for (const service of ["control-plane", "worker"])
    if (
      services[service]?.depends_on?.migrate?.condition !==
      "service_completed_successfully"
    )
      fail(`${service} does not wait for migrations`);
} else if (mode === "replica") {
  for (const service of ["control-plane", "worker"]) {
    if (services[service]?.container_name)
      fail(`${service} pins a container name`);
    if (
      mounts(service).some(
        (mount) =>
          mount.type === "volume" && mount.source !== "launcher-socket",
      )
    )
      fail(`${service} owns replica-local durable state`);
  }
} else if (mode === "isolation") {
  const owners = Object.entries(services)
    .filter(([, service]) =>
      (service.volumes ?? []).some(
        (mount) => mount.source === "/var/run/docker.sock",
      ),
    )
    .map(([name]) => name);
  if (JSON.stringify(owners) !== JSON.stringify(["worker-launcher"]))
    fail(`Docker socket owners are ${owners.join(", ") || "none"}`);
} else {
  fail("expected health, migration, replica, or isolation");
}

console.log(`[deployment:${mode}] passed`);
