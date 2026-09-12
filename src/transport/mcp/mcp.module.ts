import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import { Module } from '@nestjs/common';
import { ConversationsModule } from '../../modules/conversations/conversations.module';
import { ConversationsService } from '../../modules/conversations/conversations.service';
import { McpAuthorityService } from '../../modules/conversations/mcp-authority.service';
import { KnowledgeModule } from '../../modules/knowledge/knowledge.module';
import { UsageLedgerService } from '../../modules/billing/usage-ledger.service';
import { registerMcpRoutes } from './routes';

/**
 * Neryva MCP authority host — Phase 5 (ledger 5.1-5.2).
 *
 * Hosts `neryva.mcp.run.v1` authority + observation services over ConnectRPC
 * on the Engine's existing Fastify instance. Handlers never touch SQL — all
 * domain work goes through `McpAuthorityService` / `ConversationsService`
 * inside `src/modules/*` (exit gate). Transport security (mTLS) terminates at
 * the ingress; per-RPC authorization is the run-scoped capability token,
 * minted by the console surface (`mintRunCapability`) and validated on every
 * RPC against the RequestContext scope.
 */
@Injectable()
export class McpTransportService implements OnModuleInit {
  constructor(
    private readonly authority: McpAuthorityService,
    private readonly conversations: ConversationsService,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  async onModuleInit(): Promise<void> {
    const instance = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
    await instance.register(fastifyConnectPlugin, {
      routes: (router) => registerMcpRoutes(router, { authority: this.authority, conversations: this.conversations }),
    });
  }
}

@Module({
  // KnowledgeModule provides the ACL-before-scoring RetrievalService used by
  // GetAuthorizedRunContext / SearchKnowledge. UsageLedgerService depends only
  // on DbService, so it is provided here directly (no BillingModule cycle).
  imports: [ConversationsModule, KnowledgeModule],
  providers: [McpAuthorityService, McpTransportService, UsageLedgerService],
  exports: [McpAuthorityService],
})
export class McpModule {}
