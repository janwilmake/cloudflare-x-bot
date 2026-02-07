This cloudflare worker allows listening to a twitter stream 24/7 and replies when a tweet is received. Because there's a limitation of how long a fetch request is allowed to take, we use a durable object with an alarm and a kv for backfilling and deduplication to accomplish this. Furthermore, to set this up we first need a X_REFRESH_TOKEN to be gathered by logging in with the bot account.

Required context:

- https://docs.x.com/x-api/stream/stream-filtered-posts.md
- https://docs.x.com/x-api/posts/create-post.md
- https://flaredream.com/system-ts.md

Setup:

1. Create the streaming rule you desire

```
curl -X POST "https://api.x.com/2/tweets/search/stream/rules" \
  -H "Authorization: Bearer BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "add": [
      {
        "value": "@xy_make -is:reply",
        "tag": "mentions_not_replies"
      }
    ]
  }'
```

2. Deploy this with `.env` filled in.
3. Visit `/oauth/authorize` and login with the bot account to gather `X_REFRESH_TOKEN` and redeploy with that token.
4. Run `/start`

# Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Cloudflare Worker                           │
│                                                                     │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐   │
│  │ HTTP Endpoints   │    │ Cron Trigger     │    │ Queue        │   │
│  │                  │    │ (every 2 min)    │    │ Consumer     │   │
│  │ /start           │    │                  │    │              │   │
│  │ /stop            │    │ Health Check ────┼───▶│ Process      │   │
│  │ /status          │    │ Auto-restart     │    │ Tweets       │   │
│  └────────┬─────────┘    └────────┬─────────┘    └──────┬───────┘   │
│           │                       │                     │           │
│           └───────────────────────┼─────────────────────┘           │
│                                   │                                 │
│                                   ▼                                 │
│           ┌───────────────────────────────────────────┐             │
│           │     StreamHandler Durable Object          │             │
│           │         (Singleton Instance)              │             │
│           │                                           │             │
│           │  ┌─────────────────────────────────────┐  │             │
│           │  │ SQLite KV Table                     │  │             │
│           │  │ - lastTweetTime                     │  │             │
│           │  │ - tweet:${id} (deduplication)       │  │             │
│           │  │ - expiry timestamps                 │  │             │
│           │  └─────────────────────────────────────┘  │             │
│           │                                           │             │
│           │  ┌─────────────────────────────────────┐  │             │
│           │  │ Stream Processing Logic             │  │             │
│           │  │ - AbortController                   │  │             │
│           │  │ - Alarm (25s auto-restart)          │  │             │
│           │  │ - Backfill calculation              │  │             │
│           │  └─────────────────────────────────────┘  │             │
│           └───────────┬───────────────────┬───────────┘             │
│                       │                   │                         │
└───────────────────────┼───────────────────┼─────────────────────────┘
                        │                   │
                        ▼                   ▼
        ┌───────────────────────┐   ┌─────────────────┐
        │   X API Stream        │   │  STREAM_QUEUE   │
        │   /2/tweets/search/   │   │                 │
        │   stream              │   │  ┌───────────┐  │
        │                       │   │  │ Message 1 │  │
        │ - Filtered tweets     │   │  ├───────────┤  │
        │ - Real-time feed      │   │  │ Message 2 │  │
        │ - Auto-reconnect      │   │  ├───────────┤  │
        │   every 25s           │   │  │ Message 3 │  │
        │ - Backfill support    │   │  └───────────┘  │
        │   (up to 5 min)       │   │                 │
        └───────────────────────┘   └────────┬────────┘
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │ X API Reply     │
                                    │ POST /2/tweets  │
                                    │                 │
                                    │ Reply with:     │
                                    │ "hello,world"   │
                                    └─────────────────┘
```
