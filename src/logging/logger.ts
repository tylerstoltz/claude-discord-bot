import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private level: LogLevel;
  private useTimestamps: boolean;
  private useColors: boolean;

  constructor(level: LogLevel = 'info', useTimestamps = true, useColors = true) {
    this.level = level;
    this.useTimestamps = useTimestamps;
    this.useColors = useColors;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  private formatMessage(level: LogLevel, prefix: string, message: string, details?: string): string {
    const timestamp = this.useTimestamps ? `[${new Date().toISOString()}] ` : '';
    const levelStr = level.toUpperCase().padEnd(5);
    const detailsStr = details ? ` | ${details}` : '';

    if (this.useColors) {
      const levelColors = {
        debug: chalk.gray,
        info: chalk.blue,
        warn: chalk.yellow,
        error: chalk.red
      };

      return `${chalk.gray(timestamp)}${levelColors[level](levelStr)} ${prefix} | ${message}${chalk.gray(detailsStr)}`;
    }

    return `${timestamp}${levelStr} ${prefix} | ${message}${detailsStr}`;
  }

  debug(prefix: string, message: string, details?: string): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', prefix, message, details));
    }
  }

  info(prefix: string, message: string, details?: string): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', prefix, message, details));
    }
  }

  warn(prefix: string, message: string, details?: string): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', prefix, message, details));
    }
  }

  error(prefix: string, message: string, details?: string): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', prefix, message, details));
    }
  }

  // Convenience methods with emojis
  channelActivity(channelId: string, activity: string, details?: string): void {
    const shortId = channelId.slice(-6);
    this.info(`📢 Ch:${shortId}`, activity, details);
  }

  toolUse(toolName: string, input: string): void {
    this.debug('⚙️  TOOL', toolName, input.slice(0, 100));
  }

  streaming(bytes: number): void {
    if (this.shouldLog('debug')) {
      process.stdout.write(`  ✍️  Streaming: ${bytes} chars\r`);
    }
  }

  streamingComplete(): void {
    if (this.shouldLog('debug')) {
      process.stdout.write('\n');
    }
  }

  complete(duration: number, cost?: number): void {
    const details = cost ? `Duration: ${duration}ms | Cost: $${cost.toFixed(4)}` : `Duration: ${duration}ms`;
    this.info('✅ COMPLETE', '', details);
  }
}
