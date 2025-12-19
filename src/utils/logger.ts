type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  private module: string;
  private static minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

  constructor(module: string) {
    this.module = module;
  }

  debug(msg: string): void { this.log("debug", msg); }
  info(msg: string): void { this.log("info", msg); }
  warn(msg: string): void { this.log("warn", msg); }
  error(msg: string): void { this.log("error", msg); }

  private log(level: LogLevel, msg: string): void {
    if (LEVELS[level] < LEVELS[Logger.minLevel]) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${this.module}]`;
    if (level === "error") console.error(`${prefix} ${msg}`);
    else if (level === "warn") console.warn(`${prefix} ${msg}`);
    else console.log(`${prefix} ${msg}`);
  }
}
