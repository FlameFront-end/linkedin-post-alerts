// Deliberately do not serialize errors: provider URLs can contain session/token secrets.
export function log(
  service: string,
  event: string,
  fields: Record<string, string | number | boolean> = {},
) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service,
      event,
      ...fields,
    }),
  );
}
