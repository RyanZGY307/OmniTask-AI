// ================================================================
// Universal Connect Runtime v2 — Register all connectors
// Run this at startup to make all connectors available
// ================================================================

import { registerConnector, registerToolMapping } from './base';
import { OAuthConnector } from './oauth';
import { ApiKeyConnector } from './api';
import { BrowserConnector } from './browser';
import { MCPConnector } from './mcp';
import { PluginConnector } from './plugin';
import { GenericWebConnector } from './generic_web';
import { TokenConnector } from './token';

export function registerAllConnectors(): void {
  const oauth = new OAuthConnector();
  const api = new ApiKeyConnector();
  const browser = new BrowserConnector();
  const mcp = new MCPConnector();
  const plugin = new PluginConnector();
  const genericWeb = new GenericWebConnector();
  const token = new TokenConnector();

  registerConnector(oauth);
  registerConnector(api);
  registerConnector(browser);
  registerConnector(mcp);
  registerConnector(plugin);
  registerConnector(genericWeb);
  registerConnector(token);

  // P0-1: Register explicit tool→capability mappings
  // GitHub tools
  registerToolMapping('github', 'github.repo.read', 'repository.read');
  registerToolMapping('github', 'github.repo.write', 'repository.write');
  registerToolMapping('github', 'github.issue.read', 'issue.read');
  registerToolMapping('github', 'github.issue.create', 'issue.write');
  registerToolMapping('github', 'github.pr.read', 'pull_request.read');
  registerToolMapping('github', 'github.pr.create', 'pull_request.write');
  registerToolMapping('github', 'github.branch.list', 'repository.read');
  registerToolMapping('github', 'github.commit.read', 'repository.read');
  registerToolMapping('github', 'github.actions.read', 'actions.read');
  registerToolMapping('github', 'github.health', 'health.check');

  // Slack tools
  registerToolMapping('slack', 'slack.channels.list', 'channel.list');
  registerToolMapping('slack', 'slack.chat.post', 'chat.send');
  registerToolMapping('slack', 'slack.health', 'health.check');

  // Discord tools
  registerToolMapping('discord', 'discord.identify', 'user.identify');

  // OpenAI tools
  registerToolMapping('openai', 'openai.models.list', 'openai.models.list');
  registerToolMapping('openai', 'openai.health', 'health.check');

  // Stripe tools
  registerToolMapping('stripe', 'stripe.balance.get', 'stripe.balance.get');
  registerToolMapping('stripe', 'stripe.customer.list', 'stripe.customer.list');
  registerToolMapping('stripe', 'stripe.health', 'health.check');

  // Generic browser (login + 上网) tools → browser connector capabilities
  registerToolMapping('web', 'web.navigate', 'browser.navigate');
  registerToolMapping('web', 'web.read', 'browser.read');
  registerToolMapping('web', 'web.screenshot', 'browser.read');
  registerToolMapping('web', 'web.click', 'browser.act');
  registerToolMapping('web', 'web.input', 'browser.act');
  registerToolMapping('web', 'web.login', 'browser.session');

  // Generic multi-token tools → token connector
  registerToolMapping('web-token', 'web-token.request', 'web.token.request');
  registerToolMapping('web-token', 'web-token.get', 'web.token.request');
  registerToolMapping('web-token', 'web-token.post', 'web.token.request');
}
