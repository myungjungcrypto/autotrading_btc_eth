import { inspect } from "node:util";

export function createLogger(scope = "app") {
  function write(level, message, context) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...(context ? { context } : {}),
    };
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else console.log(line);
  }

  return {
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => {
      const safeContext =
        context instanceof Error
          ? { name: context.name, message: context.message, stack: context.stack }
          : context;
      write("error", message, safeContext);
    },
    debug: (message, context) => {
      if (process.env.NODE_ENV === "development") write("debug", message, context);
    },
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

export function compactError(error) {
  if (!error) return undefined;
  return {
    name: error.name,
    message: error.message,
    details: error.body ? inspect(error.body, { depth: 3 }) : undefined,
  };
}
