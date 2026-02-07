/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";

export interface Env {
  STREAM_HANDLER: DurableObjectNamespace<StreamHandler>;
  STREAM_QUEUE: Queue<QueueMessage>;
  X_BEARER_TOKEN: string;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_REFRESH_TOKEN?: string;
}

interface QueueMessage {
  tweet: {
    id: string;
    text: string;
    author_id: string;
    conversation_id?: string;
    created_at: string;
  };
  includes?: {
    users?: Array<{ id: string; username: string }>;
  };
  timestamp: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface StreamRule {
  id: string;
  value: string;
  tag?: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (!env.X_BEARER_TOKEN) {
      return new Response("X_BEARER_TOKEN not configured", { status: 500 });
    }

    const url = new URL(request.url);
    const id = env.STREAM_HANDLER.idFromName("stream-singleton");
    const stub = env.STREAM_HANDLER.get(id);

    // OAuth callback handler
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code) {
        return new Response("Missing code parameter", { status: 400 });
      }

      // Verify state matches
      const storedState = await stub.getStoredState();
      if (state !== storedState) {
        return new Response("State mismatch - possible CSRF attack", {
          status: 400
        });
      }

      const storedVerifier = await stub.getStoredVerifier();
      const tokens = await exchangeCodeForTokens(
        code,
        env,
        url.origin,
        storedVerifier
      );
      await stub.storeTokens(tokens);

      return new Response(
        `
        <h1>Authorization Successful!</h1>
        <p>Access token stored. Stream can now post replies.</p>
        <p><strong>Important:</strong> Save this refresh token as a backup:</p>
        <code style="word-break: break-all;">${tokens.refresh_token}</code>
        <p>You can set it as X_REFRESH_TOKEN secret.</p>
        <p><a href="/status">Check Status</a> | <a href="/start">Start Stream</a></p>
      `,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // Start OAuth flow
    if (url.pathname === "/oauth/authorize") {
      const { authUrl, state, verifier } = buildAuthUrl(
        env.X_CLIENT_ID,
        url.origin
      );
      await stub.storeOAuthState(state, verifier);
      return Response.redirect(authUrl, 302);
    }

    if (url.pathname === "/start") {
      await stub.startStream();
      return new Response("Stream started");
    }

    if (url.pathname === "/stop") {
      await stub.stopStream();
      return new Response("Stream stopped");
    }

    if (url.pathname === "/status") {
      const status = await stub.getStatus();
      const rules = await getStreamRules(env.X_BEARER_TOKEN);
      return new Response(JSON.stringify({ ...status, rules }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(`
X Stream Worker - Commands:

Stream Control:
  GET /start  - Start the stream
  GET /stop   - Stop the stream  
  GET /status - Check stream status and rules

OAuth (for posting replies):
  GET /oauth/authorize - Start OAuth flow

Example rule to match all tweets mentioning @username:
  curl -X POST https://your-worker.workers.dev/rules \\
    -H "Content-Type: application/json" \\
    -d '{"add": [{"value": "@yourusername", "tag": "mentions"}]}'
    `);
  },

  async scheduled(_event, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.STREAM_HANDLER.idFromName("stream-singleton");
    const stub = env.STREAM_HANDLER.get(id);

    const status = await stub.getStatus();

    // Restart if no tweets in last 2 minutes or not running
    if (!status.running || status.timeSinceLastTweet > 120000) {
      console.log("Stream appears dead, restarting...");
      await stub.startStream();
    }
  },

  async queue(batch, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.STREAM_HANDLER.idFromName("stream-singleton");
    const stub = env.STREAM_HANDLER.get(id);

    for (const message of batch.messages) {
      try {
        const accessToken = await stub.getValidAccessToken();

        if (!accessToken) {
          console.error(
            "No valid access token. Visit /oauth/authorize to authenticate."
          );
          message.retry({ delaySeconds: 300 });
          continue;
        }

        await replyToTweet(message.body as QueueMessage, accessToken);
        message.ack();
      } catch (error) {
        console.error("Failed to process message:", error);
        message.retry();
      }
    }
  }
} satisfies ExportedHandler<Env>;

// Generate PKCE code verifier and challenge
function generatePKCE(): { verifier: string; challenge: string } {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  // For simplicity using plain method; S256 would require async crypto
  return { verifier, challenge: verifier };
}

function buildAuthUrl(
  clientId: string,
  origin: string
): { authUrl: string; state: string; verifier: string } {
  const state = crypto.randomUUID();
  const { verifier, challenge } = generatePKCE();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${origin}/oauth/callback`,
    scope: "tweet.read tweet.write users.read offline.access",
    state,
    code_challenge: challenge,
    code_challenge_method: "plain"
  });

  return {
    authUrl: `https://twitter.com/i/oauth2/authorize?${params}`,
    state,
    verifier
  };
}

async function exchangeCodeForTokens(
  code: string,
  env: Env,
  origin: string,
  verifier: string
): Promise<TokenResponse> {
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}/oauth/callback`,
      code_verifier: verifier
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

async function getStreamRules(
  bearerToken: string
): Promise<{ data?: StreamRule[]; meta: { sent: string } }> {
  const response = await fetch(
    "https://api.x.com/2/tweets/search/stream/rules",
    {
      headers: { Authorization: `Bearer ${bearerToken}` }
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get rules: ${error}`);
  }

  return response.json();
}

async function replyToTweet(
  data: QueueMessage,
  accessToken: string
): Promise<void> {
  const { tweet } = data;

  console.log(`Replying to tweet ${tweet.id}`);

  const response = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: "hello,world",
      reply: { in_reply_to_tweet_id: tweet.id }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to reply: ${response.status} - ${error}`);
  }

  const result = (await response.json()) as { data: { id: string } };
  console.log("Successfully replied:", result.data.id);
}

export class StreamHandler extends DurableObject<Env> {
  private sql: SqlStorage;
  private streamController: AbortController | null = null;
  private lastTweetTime: number = 0;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expiry INTEGER
      )
    `);

    const result = this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM kv WHERE key = ?", "lastTweetTime")
      .toArray();
    if (result.length > 0) {
      this.lastTweetTime = parseInt(result[0].value);
    }
  }

  async storeOAuthState(state: string, verifier: string): Promise<void> {
    const expiry = Date.now() + 600000; // 10 minutes
    this.sql.exec(
      "INSERT OR REPLACE INTO kv (key, value, expiry) VALUES (?, ?, ?)",
      "oauth_state",
      state,
      expiry
    );
    this.sql.exec(
      "INSERT OR REPLACE INTO kv (key, value, expiry) VALUES (?, ?, ?)",
      "oauth_verifier",
      verifier,
      expiry
    );
  }

  async getStoredState(): Promise<string | null> {
    const result = this.sql
      .exec<{
        value: string;
      }>(
        "SELECT value FROM kv WHERE key = ? AND (expiry IS NULL OR expiry > ?)",
        "oauth_state",
        Date.now()
      )
      .toArray();
    return result.length > 0 ? result[0].value : null;
  }

  async getStoredVerifier(): Promise<string> {
    const result = this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM kv WHERE key = ?", "oauth_verifier")
      .toArray();
    return result.length > 0 ? result[0].value : "challenge";
  }

  async storeTokens(tokens: TokenResponse): Promise<void> {
    const expiresAt = Date.now() + tokens.expires_in * 1000;

    this.sql.exec(
      "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
      "access_token",
      tokens.access_token
    );
    this.sql.exec(
      "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
      "refresh_token",
      tokens.refresh_token
    );
    this.sql.exec(
      "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
      "token_expires_at",
      expiresAt.toString()
    );
  }

  async getValidAccessToken(): Promise<string | null> {
    const accessTokenRow = this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM kv WHERE key = ?", "access_token")
      .toArray();
    const expiresAtRow = this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM kv WHERE key = ?", "token_expires_at")
      .toArray();

    if (accessTokenRow.length > 0 && expiresAtRow.length > 0) {
      const expiresAt = parseInt(expiresAtRow[0].value);

      if (Date.now() < expiresAt - 300000) {
        return accessTokenRow[0].value;
      }
    }

    return await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<string | null> {
    let refreshToken: string | null = null;

    const refreshTokenRow = this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM kv WHERE key = ?", "refresh_token")
      .toArray();

    if (refreshTokenRow.length > 0) {
      refreshToken = refreshTokenRow[0].value;
    } else if (this.env.X_REFRESH_TOKEN) {
      refreshToken = this.env.X_REFRESH_TOKEN;
    }

    if (!refreshToken) {
      console.error("No refresh token available");
      return null;
    }

    try {
      const response = await fetch("https://api.x.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${this.env.X_CLIENT_ID}:${this.env.X_CLIENT_SECRET}`)}`
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Token refresh failed:", error);
        return null;
      }

      const tokens: TokenResponse = await response.json();
      await this.storeTokens(tokens);

      console.log("Token refreshed successfully");
      return tokens.access_token;
    } catch (error) {
      console.error("Token refresh error:", error);
      return null;
    }
  }

  async alarm() {
    console.log("Alarm triggered, restarting stream...");
    await this.startStream();
  }

  async startStream(): Promise<void> {
    this.stopStream();
    this.streamController = new AbortController();
    await this.ctx.storage.setAlarm(Date.now() + 25000);

    // No backfill_minutes - requires elevated access
    const params = new URLSearchParams({
      "tweet.fields": "created_at,author_id,conversation_id",
      expansions: "author_id",
      "user.fields": "username"
    });

    try {
      const response = await fetch(
        `https://api.x.com/2/tweets/search/stream?${params}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${this.env.X_BEARER_TOKEN}` },
          signal: this.streamController.signal
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Stream error: ${response.status} - ${error}`);
      }

      console.log("Stream connected successfully");
      await this.processStream(response.body!);
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Stream error:", error);
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      }
    }
  }

  stopStream(): void {
    if (this.streamController) {
      this.streamController.abort();
      this.streamController = null;
    }
  }

  async getStatus(): Promise<{
    running: boolean;
    lastTweetTime: number;
    timeSinceLastTweet: number;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
  }> {
    const accessTokenRow = this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM kv WHERE key = ?", "access_token")
      .toArray();
    const refreshTokenRow = this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM kv WHERE key = ?", "refresh_token")
      .toArray();

    return {
      running: this.streamController !== null,
      lastTweetTime: this.lastTweetTime,
      timeSinceLastTweet: Date.now() - this.lastTweetTime,
      hasAccessToken: accessTokenRow.length > 0,
      hasRefreshToken: refreshTokenRow.length > 0 || !!this.env.X_REFRESH_TOKEN
    };
  }

  private async processStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\r\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            await this.handleTweet(line);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async handleTweet(line: string): Promise<void> {
    try {
      const data = JSON.parse(line);

      // Skip if no data (heartbeat or error)
      if (!data.data) {
        console.log("Non-tweet message:", line.substring(0, 100));
        return;
      }

      this.lastTweetTime = Date.now();
      this.sql.exec(
        "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
        "lastTweetTime",
        this.lastTweetTime.toString()
      );

      const tweetId = data.data.id;
      this.sql.exec(
        "DELETE FROM kv WHERE expiry IS NOT NULL AND expiry < ?",
        Date.now()
      );

      const exists = this.sql
        .exec("SELECT key FROM kv WHERE key = ?", `tweet:${tweetId}`)
        .toArray();

      if (exists.length > 0) {
        console.log("Duplicate tweet, skipping:", tweetId);
        return;
      }

      const expiry = Date.now() + 3600000;
      this.sql.exec(
        "INSERT INTO kv (key, value, expiry) VALUES (?, ?, ?)",
        `tweet:${tweetId}`,
        "1",
        expiry
      );

      await this.env.STREAM_QUEUE.send({
        tweet: data.data,
        includes: data.includes,
        timestamp: Date.now()
      });

      console.log(
        "Queued tweet:",
        tweetId,
        "-",
        data.data.text?.substring(0, 50)
      );
    } catch (error) {
      // Ignore parse errors for heartbeats (empty lines)
      if (line.trim()) {
        console.error(
          "Failed to parse tweet:",
          error,
          "Line:",
          line.substring(0, 100)
        );
      }
    }
  }
}
