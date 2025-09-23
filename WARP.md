# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Quick Start

This repository provides TypeScript tools for implementing MCP (Model Context Protocol) clients and servers. MCP enables AI applications to request permission to access private information and services.

```bash
# Install dependencies
pnpm install

# Build the library
pnpm build

# Watch for changes during development
pnpm watch
```

## Architecture Overview

### Core Components

The library is organized into several key modules:

- **`client.ts`** - Core MCP client implementation with OAuth authentication
- **`server.ts`** - Server utilities for OAuth metadata and token verification
- **`express/index.ts`** - Express.js middleware and handlers
- **`next/index.ts`** - Next.js route handlers and utilities
- **`stores/`** - Persistent storage adapters (fs, redis, postgres, sqlite)

### Key Abstractions

#### McpClientStore Interface
All stores implement this interface for session persistence:
```typescript
interface McpClientStore {
  write: (key: string, value: JsonSerializable) => Promise<void>;
  read: (key: string) => Promise<JsonSerializable>;
}
```

#### OAuth Flow Architecture
The library handles both:
1. **Dynamic Client Registration** - Automatically registers OAuth clients with authorization servers
2. **Known Credentials** - Uses pre-existing OAuth client credentials

#### Authentication Patterns
- **Client-side**: OAuth 2.0 with PKCE for secure authentication
- **Server-side**: JWT token verification with framework-specific middleware
- **Clerk Integration**: Built-in support for Clerk authentication

## Development Commands

### Core Scripts
- `pnpm build` - Build the TypeScript library to `dist/` directory
- `pnpm watch` - Watch for changes and rebuild automatically
- `pnpm prepublishOnly` - Runs build before publishing (automatic)

### Build Configuration
- Uses `tsup` for bundling with ESM output
- Generates TypeScript declaration files
- External dependencies: `redis`, `pg`, `better-sqlite3` (peer dependencies)
- Entry points: `client.ts`, `server.ts`, framework adapters, and store implementations

## Framework Integrations

### Express.js

Located in `express/index.ts`, provides middleware and handlers:

#### Authentication Middleware
```typescript
// Generic auth middleware
app.post('/mcp', await mcpAuth(verifyToken), streamableHttpHandler(server));

// Clerk-specific auth (recommended)
app.post('/mcp', mcpAuthClerk, streamableHttpHandler(server));
```

#### Required Routes
```typescript
// OAuth metadata endpoint
app.get('/.well-known/oauth-protected-resource', protectedResourceHandlerClerk());

// Authorization server metadata (for Clerk)
app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);
```

#### Environment Variables
- `CLERK_PUBLISHABLE_KEY` - For metadata generation
- `CLERK_SECRET_KEY` - For server-side API calls

### Next.js

Located in `next/index.ts`, supports App Router patterns:

#### API Route Structure
```typescript
// app/mcp/route.ts - Main MCP endpoint
import { verifyClerkToken } from '@clerk/mcp-tools/next';
import { createMcpHandler, experimental_withMcpAuth as withMcpAuth } from '@vercel/mcp-adapter';

// app/.well-known/oauth-protected-resource/route.ts
import { protectedResourceHandlerClerk } from '@clerk/mcp-tools/next';
const handler = protectedResourceHandlerClerk();
export { handler as GET };

// app/oauth_callback/route.ts
import { completeOAuthHandler } from '@clerk/mcp-tools/next';
const handler = completeOAuthHandler({ store, callback });
export { handler as GET };
```

#### CORS Support
```typescript
// For browser-based MCP clients
import { metadataCorsOptionsRequestHandler } from '@clerk/mcp-tools/next';
export { corsHandler as OPTIONS };
```

## Store Implementations

### Development Store
**File System Store** (`stores/fs.ts`)
- **Use case**: Local development and testing
- **Configuration**: Optional file path (defaults to temp directory)
- **Features**: Automatic cleanup, statistics, key listing

### Production Stores

**Redis Store** (`stores/redis.ts`)
- **Use case**: High-performance, distributed applications
- **Configuration**: Host, port, password, TTL support
- **Features**: Connection pooling, automatic expiration

**PostgreSQL Store** (`stores/postgres.ts`)
- **Use case**: Relational data requirements, ACID compliance
- **Configuration**: Connection string or individual parameters
- **Features**: Automatic table creation, JSONB storage, indexing

**SQLite Store** (`stores/sqlite.ts`)
- **Use case**: Serverless deployments, embedded applications
- **Configuration**: Database file path
- **Features**: File-based persistence, no server required

### Store Selection Guide
- **Development**: Use `fsStore` for simplicity
- **Production (serverless)**: Use `sqlite` or `postgres`
- **Production (containerized)**: Use `redis` or `postgres`
- **High availability**: Use `redis` with clustering

## Environment Variables

### Clerk Integration (Recommended)
```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_... # For metadata generation
CLERK_SECRET_KEY=sk_test_...                  # For server operations
CLERK_PUBLISHABLE_KEY=pk_test_...             # Express.js variant
```

### Custom OAuth Providers
```bash
OAUTH_AUTHORIZATION_SERVER_URL=https://auth.example.com  # Your OAuth server
JWT_SECRET=your-jwt-secret                               # For custom JWT verification
```

### Store Configuration
```bash
# Redis
REDIS_URL=redis://localhost:6379

# PostgreSQL
DATABASE_URL=postgresql://user:password@localhost:5432/database

# SQLite (file path)
SQLITE_DATABASE_PATH=./data/mcp-sessions.db
```

## Common Patterns

### Client Creation Pattern
```typescript
import { createDynamicallyRegisteredMcpClient } from '@clerk/mcp-tools/client';
import { createRedisStore } from '@clerk/mcp-tools/stores/redis';

const store = createRedisStore({ url: process.env.REDIS_URL });

const { connect, sessionId } = createDynamicallyRegisteredMcpClient({
  mcpEndpoint: 'https://api.example.com/mcp',
  oauthRedirectUrl: 'https://yourapp.com/oauth_callback',
  mcpClientName: 'My App',
  mcpClientVersion: '1.0.0',
  redirect: (url) => window.location.href = url,
  store,
});
```

### Tool Implementation Pattern
```typescript
server.tool(
  'tool-name',
  'Tool description',
  { type: 'object', properties: {} }, // JSON schema
  async (args, { authInfo }) => {
    // Access authenticated user data
    const { userId } = authInfo as any;
    
    return {
      content: [{ type: 'text', text: 'Response' }]
    };
  }
);
```

### Error Handling Pattern
```typescript
// Client-side
try {
  const result = await client.callTool({ name: 'tool-name', arguments: {} });
} catch (error) {
  // Handle MCP errors, auth errors, network errors
}

// Server-side middleware
app.use((error, req, res, next) => {
  if (error.message.includes('Unauthorized')) {
    res.status(401).json({ error: 'Authentication required' });
  }
  // Handle other errors
});
```

## Key Files and Their Purposes

- **`client.ts`** - OAuth flow management, session handling, MCP client creation
- **`server.ts`** - OAuth metadata generation, token verification utilities
- **`express/index.ts`** - Express middleware for authentication and MCP request handling
- **`next/index.ts`** - Next.js route handlers for OAuth endpoints and MCP requests
- **`stores/*.ts`** - Persistent storage implementations for session data
- **`package.json`** - Build configuration, dependencies, and export mappings
- **`tsconfig.json`** - TypeScript configuration with strict mode enabled

## TypeScript Configuration

The project uses strict TypeScript settings:
- Target: ES2017
- Module: ESNext with bundler resolution
- Strict mode enabled
- Isolated modules for better build performance
- DOM types included for browser compatibility

## Build System

Uses `tsup` for building:
- ESM-only output format
- TypeScript declaration generation
- Multiple entry points for framework-specific adapters
- External peer dependencies to reduce bundle size
- Clean builds enabled

## Testing Strategy

While no test files exist yet, the architecture supports:
- Unit testing individual functions and classes
- Integration testing with real OAuth providers
- Store implementation testing with different backends
- Framework middleware testing with mock requests

## Common Issues and Solutions

### Authentication Failures
- Verify environment variables are set correctly
- Check OAuth redirect URLs match exactly
- Ensure CORS is configured for browser clients

### Store Connection Issues
- Verify database/Redis credentials and connectivity
- Check if required peer dependencies are installed
- Review store configuration parameters

### Build Issues
- Run `pnpm install` to ensure all dependencies are present
- Check TypeScript version compatibility
- Verify `tsup` configuration matches project structure

### Framework Integration Issues
- Ensure middleware is applied in correct order
- Check route paths match expected OAuth callback URLs
- Verify framework-specific export patterns (Next.js App Router vs Pages Router)