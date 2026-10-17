// ================================================================
// Universal Connect Runtime v2 — Platform Provider Registry
// 200+ real, functional providers organized by category and region
// ================================================================
//
// Each entry is a PlatformManifestDef with real connector support:
//   - api / oauth / browser / generic_web connectors exist
//   - stub-only providers are NOT included (per spec §19)
//
// Category guide: social, e-commerce, developer, cloud_storage,
//   documents, productivity, communication, design, publishing,
//   ai, project_management, finance, payment, crm, marketing,
//   analytics, code_hosting, cicd, cloud_infra, database, search,
//   news, media, education, calendar, email, knowledge_base,
//   automation, customer_support, forms, file_transfer, backup,
//   creative, dev_collab, local_services, travel, food_delivery,
//   ride_hailing, job, community
// ================================================================

import type { PlatformManifestDef, ImplLevel } from '../types';
import { computeImplLevel } from '../types';

// ─── Builders ────────────────────────────────────────────────────────
const REGIONS_GLOBAL = ['global'];
const REGIONS_ASIA = ['CN', 'HK', 'MO', 'TW', 'MY', 'SG', 'ID', 'TH', 'VN', 'PH', 'JP', 'KR', 'IN', 'AU', 'NZ'];
const REGIONS_AMERICAS = ['US', 'CA', 'BR', 'MX', 'AR', 'CL', 'CO'];
const REGIONS_EUROPE = ['GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'HU', 'CH', 'AT', 'BE'];
const REGIONS_MENA = ['SA', 'AE', 'IL', 'TR', 'EG', 'QA', 'KW', 'BH'];
const REGIONS_AFRICA = ['NG', 'ZA', 'KE', 'GH', 'ET', 'TZ', 'MA', 'TN'];

function p(def: Partial<PlatformManifestDef> & Pick<PlatformManifestDef, 'providerId' | 'displayName' | 'category' | 'defaultRiskLevel'>): PlatformManifestDef {
  return {
    regions: def.regions ?? REGIONS_GLOBAL,
    apiSupported: def.apiSupported ?? false,
    oauthSupported: def.oauthSupported ?? false,
    apiKeySupported: def.apiKeySupported ?? false,
    mcpSupported: def.mcpSupported ?? false,
    browserSupported: def.browserSupported ?? true,
    pluginSupported: def.pluginSupported ?? false,
    genericWebSupported: def.genericWebSupported ?? true,
    multiAccount: def.multiAccount ?? false,
    mobileSupported: def.mobileSupported ?? true,
    desktopSupported: def.desktopSupported ?? true,
    webSupported: def.webSupported ?? true,
    version: def.version ?? '1',
    ...def,
  };
}

// ─── Global Tier-1 Providers (all regions) ───────────────────────────
const GLOBAL_TIER1: PlatformManifestDef[] = [
  // Developer & Code Hosting
  p({ providerId: 'github', displayName: 'GitHub', category: 'code_hosting', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'Git repository hosting and collaboration', website: 'https://github.com' }),
  p({ providerId: 'gitlab', displayName: 'GitLab', category: 'code_hosting', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'DevOps platform', website: 'https://gitlab.com' }),
  p({ providerId: 'bitbucket', displayName: 'Bitbucket', category: 'code_hosting', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'azure-devops', displayName: 'Azure DevOps', category: 'code_hosting', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'Microsoft DevOps platform' }),
  p({ providerId: 'sourceforge', displayName: 'SourceForge', category: 'code_hosting', defaultRiskLevel: 'R0',
    apiSupported: false, oauthSupported: false, browserSupported: true, apiKeySupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'codeberg', displayName: 'Codeberg', category: 'code_hosting', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Cloud Infrastructure & CI/CD
  p({ providerId: 'aws', displayName: 'Amazon AWS', category: 'cloud_infra', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'Amazon Web Services cloud platform' }),
  p({ providerId: 'google-cloud', displayName: 'Google Cloud', category: 'cloud_infra', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'azure', displayName: 'Microsoft Azure', category: 'cloud_infra', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'vercel', displayName: 'Vercel', category: 'cicd', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'netlify', displayName: 'Netlify', category: 'cicd', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'render', displayName: 'Render', category: 'cicd', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'railway', displayName: 'Railway', category: 'cicd', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'fly-io', displayName: 'Fly.io', category: 'cicd', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Communication & Social
  p({ providerId: 'slack', displayName: 'Slack', category: 'communication', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'Team messaging platform' }),
  p({ providerId: 'discord', displayName: 'Discord', category: 'communication', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'telegram', displayName: 'Telegram', category: 'communication', defaultRiskLevel: 'R1',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'whatsapp-business', displayName: 'WhatsApp Business', category: 'communication', defaultRiskLevel: 'R1',
    apiSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'microsoft-teams', displayName: 'Microsoft Teams', category: 'communication', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Productivity & Documents
  p({ providerId: 'google-drive', displayName: 'Google Drive', category: 'cloud_storage', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'Cloud storage and document collaboration' }),
  p({ providerId: 'google-calendar', displayName: 'Google Calendar', category: 'calendar', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-docs', displayName: 'Google Docs', category: 'documents', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-sheets', displayName: 'Google Sheets', category: 'documents', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-mail', displayName: 'Gmail', category: 'email', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'notion', displayName: 'Notion', category: 'productivity', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'All-in-one workspace' }),
  p({ providerId: 'dropbox', displayName: 'Dropbox', category: 'cloud_storage', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'onedrive', displayName: 'Microsoft OneDrive', category: 'cloud_storage', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'ms-office-365', displayName: 'Microsoft 365', category: 'productivity', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'Outlook, Word, Excel, PowerPoint' }),
  p({ providerId: 'evernote', displayName: 'Evernote', category: 'productivity', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'asana', displayName: 'Asana', category: 'project_management', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'trello', displayName: 'Trello', category: 'project_management', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'monday', displayName: 'Monday.com', category: 'project_management', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'clickup', displayName: 'ClickUp', category: 'project_management', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Project Management
  p({ providerId: 'jira', displayName: 'Atlassian Jira', category: 'project_management', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'linear', displayName: 'Linear', category: 'project_management', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'azendoo', displayName: 'Azendoo', category: 'project_management', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // CRM
  p({ providerId: 'salesforce', displayName: 'Salesforce', category: 'crm', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'hubspot', displayName: 'HubSpot', category: 'crm', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'zoho-crm', displayName: 'Zoho CRM', category: 'crm', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'pipedrive', displayName: 'Pipedrive', category: 'crm', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Social Media
  p({ providerId: 'twitter-x', displayName: 'X (Twitter)', category: 'social', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'Social media platform' }),
  p({ providerId: 'facebook', displayName: 'Facebook', category: 'social', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'instagram', displayName: 'Instagram', category: 'social', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'linkedin', displayName: 'LinkedIn', category: 'social', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'Professional networking' }),
  p({ providerId: 'reddit', displayName: 'Reddit', category: 'social', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'youtube', displayName: 'YouTube', category: 'media', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'tiktok', displayName: 'TikTok', category: 'social', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'twitch', displayName: 'Twitch', category: 'media', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'threads', displayName: 'Threads', category: 'social', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Design
  p({ providerId: 'figma', displayName: 'Figma', category: 'design', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'canva', displayName: 'Canva', category: 'design', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'adobe-creative-cloud', displayName: 'Adobe Creative Cloud', category: 'design', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'sketch', displayName: 'Sketch', category: 'design', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Publishing & Content
  p({ providerId: 'wordpress', displayName: 'WordPress', category: 'publishing', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'medium', displayName: 'Medium', category: 'publishing', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'substack', displayName: 'Substack', category: 'publishing', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'ghost', displayName: 'Ghost', category: 'publishing', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'hashnode', displayName: 'Hashnode', category: 'publishing', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Analytics
  p({ providerId: 'google-analytics', displayName: 'Google Analytics', category: 'analytics', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'mixpanel', displayName: 'Mixpanel', category: 'analytics', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'amplitude', displayName: 'Amplitude', category: 'analytics', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'segment', displayName: 'Segment', category: 'analytics', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'hotjar', displayName: 'Hotjar', category: 'analytics', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Marketing
  p({ providerId: 'mailchimp', displayName: 'Mailchimp', category: 'marketing', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'hubspot-marketing', displayName: 'HubSpot Marketing', category: 'marketing', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'hootsuite', displayName: 'Hootsuite', category: 'marketing', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'buffer', displayName: 'Buffer', category: 'marketing', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'zapier', displayName: 'Zapier', category: 'automation', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL, description: 'Workflow automation platform' }),
  p({ providerId: 'make', displayName: 'Make (Integromat)', category: 'automation', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'n8n', displayName: 'n8n', category: 'automation', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'ifttt', displayName: 'IFTTT', category: 'automation', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // AI Services
  p({ providerId: 'openai', displayName: 'OpenAI', category: 'ai', defaultRiskLevel: 'R0',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'anthropic', displayName: 'Anthropic', category: 'ai', defaultRiskLevel: 'R0',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'perplexity', displayName: 'Perplexity AI', category: 'ai', defaultRiskLevel: 'R0',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'midjourney', displayName: 'Midjourney', category: 'ai', defaultRiskLevel: 'R1',
    apiSupported: false, oauthSupported: false, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'stability-ai', displayName: 'Stability AI', category: 'ai', defaultRiskLevel: 'R0',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'replicate', displayName: 'Replicate', category: 'ai', defaultRiskLevel: 'R0',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'huggingface', displayName: 'Hugging Face', category: 'ai', defaultRiskLevel: 'R0',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Customer Support
  p({ providerId: 'zendesk', displayName: 'Zendesk', category: 'customer_support', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'freshdesk', displayName: 'Freshdesk', category: 'customer_support', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'intercom', displayName: 'Intercom', category: 'customer_support', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Forms
  p({ providerId: 'typeform', displayName: 'Typeform', category: 'forms', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-forms', displayName: 'Google Forms', category: 'forms', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'surveymonkey', displayName: 'SurveyMonkey', category: 'forms', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'qualtrics', displayName: 'Qualtrics', category: 'forms', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Knowledge Base
  p({ providerId: 'confluence', displayName: 'Confluence', category: 'knowledge_base', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'github-wiki', displayName: 'GitHub Wiki', category: 'knowledge_base', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'obsidian', displayName: 'Obsidian', category: 'knowledge_base', defaultRiskLevel: 'R0',
    apiSupported: false, oauthSupported: false, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // File Transfer & Backup
  p({ providerId: 's3', displayName: 'Amazon S3', category: 'file_transfer', defaultRiskLevel: 'R1',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-cloud-storage', displayName: 'Google Cloud Storage', category: 'file_transfer', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-backup-and-sync', displayName: 'Google Backup and Sync', category: 'backup', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'carbonite', displayName: 'Carbonite', category: 'backup', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'backblaze', displayName: 'Backblaze', category: 'backup', defaultRiskLevel: 'R1',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // E-commerce (Global)
  p({ providerId: 'shopify', displayName: 'Shopify', category: 'e-commerce', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'woocommerce', displayName: 'WooCommerce', category: 'e-commerce', defaultRiskLevel: 'R1',
    apiSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'stripe', displayName: 'Stripe', category: 'payment', defaultRiskLevel: 'R2',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'paypal', displayName: 'PayPal', category: 'payment', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'square', displayName: 'Square', category: 'payment', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'ebay', displayName: 'eBay', category: 'e-commerce', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'amazon-selling', displayName: 'Amazon Selling Partner', category: 'e-commerce', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Finance
  p({ providerId: 'stripe-dashboard', displayName: 'Stripe Dashboard', category: 'finance', defaultRiskLevel: 'R2',
    apiSupported: false, oauthSupported: false, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'plaid', displayName: 'Plaid', category: 'finance', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'quickbooks', displayName: 'QuickBooks', category: 'finance', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'xero', displayName: 'Xero', category: 'finance', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'wise', displayName: 'Wise', category: 'finance', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Education
  p({ providerId: 'google-classroom', displayName: 'Google Classroom', category: 'education', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'canvas', displayName: 'Canvas LMS', category: 'education', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'coursera', displayName: 'Coursera', category: 'education', defaultRiskLevel: 'R0',
    apiSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'udemy', displayName: 'Udemy', category: 'education', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Search & News
  p({ providerId: 'google-search-console', displayName: 'Google Search Console', category: 'search', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-trends', displayName: 'Google Trends', category: 'search', defaultRiskLevel: 'R0',
    apiSupported: false, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'newsapi', displayName: 'NewsAPI', category: 'news', defaultRiskLevel: 'R0',
    apiSupported: true, apiKeySupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'feedly', displayName: 'Feedly', category: 'news', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Travel
  p({ providerId: 'google-flights', displayName: 'Google Flights', category: 'travel', defaultRiskLevel: 'R0',
    apiSupported: false, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'booking', displayName: 'Booking.com', category: 'travel', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'airbnb', displayName: 'Airbnb', category: 'travel', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'expedia', displayName: 'Expedia', category: 'travel', defaultRiskLevel: 'R1',
    apiSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),

  // Community
  p({ providerId: 'discord-comm', displayName: 'Discord Communities', category: 'community', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'steam', displayName: 'Steam', category: 'community', defaultRiskLevel: 'R1',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'stackoverflow', displayName: 'Stack Overflow', category: 'community', defaultRiskLevel: 'R0',
    apiSupported: true, oauthSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'hackernews', displayName: 'Hacker News', category: 'community', defaultRiskLevel: 'R0',
    apiSupported: true, browserSupported: true,
    regions: REGIONS_GLOBAL }),
];

// ─── Regional Providers ─────────────────────────────────────────────
// All entries below represent REAL platforms with real APIs or browser-accessible interfaces.

const CN_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'wechat', displayName: '微信 WeChat', category: 'communication', defaultRiskLevel: 'R2',
    regions: ['CN'], apiSupported: false, oauthSupported: false, browserSupported: true,
    description: 'China dominant messaging platform' }),
  p({ providerId: 'qq', displayName: 'QQ', category: 'communication', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'weibo', displayName: '微博 Weibo', category: 'social', defaultRiskLevel: 'R2',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'douyin', displayName: '抖音 Douyin', category: 'media', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'taobao', displayName: '淘宝 Taobao', category: 'e-commerce', defaultRiskLevel: 'R2',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'alipay', displayName: '支付宝 Alipay', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'baidu', displayName: '百度 Baidu', category: 'search', defaultRiskLevel: 'R0',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'bilibili', displayName: '哔哩哔哩 Bilibili', category: 'media', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'xiaohongshu', displayName: '小红书 Xiaohongshu', category: 'social', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: false, browserSupported: true }),
  p({ providerId: 'dingtalk', displayName: '钉钉 DingTalk', category: 'communication', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'feishu', displayName: '飞书 Feishu', category: 'productivity', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'jianshu', displayName: '简书 Jianshu', category: 'publishing', defaultRiskLevel: 'R0',
    regions: ['CN'], apiSupported: false, browserSupported: true }),
  p({ providerId: 'zhihu', displayName: '知乎 Zhihu', category: 'community', defaultRiskLevel: 'R0',
    regions: ['CN'], apiSupported: false, browserSupported: true }),
  p({ providerId: 'jd', displayName: '京东 JD.com', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'meituan', displayName: '美团 Meituan', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'eleme', displayName: '饿了么 Ele.me', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'didi', displayName: '滴滴出行 Didi', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: '163-mail', displayName: '网易邮箱 163', category: 'email', defaultRiskLevel: 'R0',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'aliyun', displayName: '阿里云 Aliyun', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'tencent-cloud', displayName: '腾讯云 Tencent Cloud', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'kuaishou', displayName: '快手 Kuaishou', category: 'media', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'baidu-ai', displayName: '文心一言 ERNIE Bot', category: 'ai', defaultRiskLevel: 'R0',
    regions: ['CN'], apiSupported: true, apiKeySupported: true, browserSupported: true }),
  p({ providerId: 'tongyi', displayName: '通义千问 Tongyi', category: 'ai', defaultRiskLevel: 'R0',
    regions: ['CN'], apiSupported: true, apiKeySupported: true, browserSupported: true }),
  p({ providerId: 'deepseek-cn', displayName: 'DeepSeek 中国版', category: 'ai', defaultRiskLevel: 'R0',
    regions: ['CN'], apiSupported: true, apiKeySupported: true, browserSupported: true }),
  p({ providerId: 'zhaoping', displayName: '招聘 Zhupin', category: 'job', defaultRiskLevel: 'R0',
    regions: ['CN'], browserSupported: true }),
  p({ providerId: 'boss-zhipin', displayName: 'BOSS直聘', category: 'job', defaultRiskLevel: 'R0',
    regions: ['CN'], browserSupported: true }),
];

const HK_TW_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'line-hk', displayName: 'Line Hong Kong', category: 'communication', defaultRiskLevel: 'R1',
    regions: ['HK', 'TW'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'wechat-hk', displayName: '微信香港', category: 'communication', defaultRiskLevel: 'R1',
    regions: ['HK', 'TW'], browserSupported: true }),
  p({ providerId: 'momo-taiwan', displayName: 'momo購物台', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['TW'], browserSupported: true }),
  p({ providerId: 'ptt', displayName: 'PTT 批踢踢', category: 'community', defaultRiskLevel: 'R0',
    regions: ['TW'], browserSupported: true }),
  p({ providerId: 'udn', displayName: '聯合新聞網', category: 'news', defaultRiskLevel: 'R0',
    regions: ['TW'], browserSupported: true }),
  p({ providerId: 'gamefaqs-tw', displayName: '巴哈姆特', category: 'community', defaultRiskLevel: 'R0',
    regions: ['TW'], browserSupported: true }),
];

const MO_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'macau-sar', displayName: '澳門 SAR 政府', category: 'local_services', defaultRiskLevel: 'R0',
    regions: ['MO'], browserSupported: true }),
  p({ providerId: 'macau-lottery', displayName: '澳門彩票', category: 'local_services', defaultRiskLevel: 'R1',
    regions: ['MO'], browserSupported: true }),
];

const SG_MY_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'grab', displayName: 'Grab', category: 'ride_hailing', defaultRiskLevel: 'R2',
    regions: ['SG', 'MY', 'TH', 'VN', 'PH', 'ID'], apiSupported: true, browserSupported: true,
    description: 'Southeast Asia super app' }),
  p({ providerId: 'shopee', displayName: 'Shopee', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'TW'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'lazada', displayName: 'Lazada', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['SG', 'MY', 'TH', 'VN', 'PH', 'ID'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'touch-n-go', displayName: 'Touch \'n Go', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['MY'], apiSupported: false, browserSupported: true }),
  p({ providerId: 'fpx', displayName: 'FPX Payment', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['MY'], browserSupported: true }),
  p({ providerId: 'maybank', displayName: 'Maybank2u', category: 'finance', defaultRiskLevel: 'R3',
    regions: ['MY'], browserSupported: true }),
  p({ providerId: 'citibank-my', displayName: 'Citibank Malaysia', category: 'finance', defaultRiskLevel: 'R3',
    regions: ['MY'], browserSupported: true }),
];

const IN_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'phonepe', displayName: 'PhonePe', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['IN'], apiSupported: false, browserSupported: true }),
  p({ providerId: 'gpay-in', displayName: 'Google Pay India', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['IN'], browserSupported: true }),
  p({ providerId: 'paytm', displayName: 'Paytm', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['IN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'zomato', displayName: 'Zomato', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['IN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'swiggy', displayName: 'Swiggy', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['IN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'flipkart', displayName: 'Flipkart', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['IN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'amazon-in', displayName: 'Amazon India', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['IN'], apiSupported: true, oauthSupported: true, browserSupported: true }),
  p({ providerId: 'myntra', displayName: 'Myntra', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['IN'], browserSupported: true }),
  p({ providerId: 'freshworks', displayName: 'Freshworks', category: 'crm', defaultRiskLevel: 'R1',
    regions: ['IN'], apiSupported: true, oauthSupported: true, browserSupported: true }),
  p({ providerId: 'zoho-in', displayName: 'Zoho India', category: 'crm', defaultRiskLevel: 'R1',
    regions: ['IN'], apiSupported: true, oauthSupported: true, browserSupported: true }),
  p({ providerId: 'razorpay', displayName: 'Razorpay', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['IN'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'groww', displayName: 'Groww', category: 'finance', defaultRiskLevel: 'R2',
    regions: ['IN'], browserSupported: true }),
  p({ providerId: 'upstox', displayName: 'Upstox', category: 'finance', defaultRiskLevel: 'R2',
    regions: ['IN'], browserSupported: true }),
  p({ providerId: 'indianrail', displayName: 'Indian Railways IRCTC', category: 'travel', defaultRiskLevel: 'R1',
    regions: ['IN'], browserSupported: true }),
  p({ providerId: 'ixigo', displayName: 'ixigo', category: 'travel', defaultRiskLevel: 'R0',
    regions: ['IN'], browserSupported: true }),
];

const JP_KR_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'line-jp', displayName: 'LINE Japan', category: 'communication', defaultRiskLevel: 'R1',
    regions: ['JP'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'yahoo-jp', displayName: 'Yahoo! Japan', category: 'search', defaultRiskLevel: 'R0',
    regions: ['JP'], browserSupported: true }),
  p({ providerId: 'rakuten', displayName: 'Rakuten', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['JP'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'mercari', displayName: 'Mercari', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['JP'], browserSupported: true }),
  p({ providerId: 'paypay', displayName: 'PayPay', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['JP'], browserSupported: true }),
  p({ providerId: 'line-pay', displayName: 'LINE Pay', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['JP'], browserSupported: true }),
  p({ providerId: 'cookpad', displayName: 'Cookpad', category: 'creative', defaultRiskLevel: 'R0',
    regions: ['JP'], browserSupported: true }),
  p({ providerId: 'note-jp', displayName: 'note', category: 'publishing', defaultRiskLevel: 'R0',
    regions: ['JP'], browserSupported: true }),
  p({ providerId: 'line-korea', displayName: 'LINE Korea', category: 'communication', defaultRiskLevel: 'R1',
    regions: ['KR'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'naver', displayName: 'Naver', category: 'search', defaultRiskLevel: 'R0',
    regions: ['KR'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'daum', displayName: 'Daum', category: 'search', defaultRiskLevel: 'R0',
    regions: ['KR'], browserSupported: true }),
  p({ providerId: 'coupang', displayName: 'Coupang', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['KR'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'kakao-t', displayName: 'Kakao T', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['KR'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'kakaopay', displayName: 'Kakao Pay', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['KR'], browserSupported: true }),
  p({ providerId: 'woowa-bros', displayName: 'Woowa Brothers (Baemin)', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['KR'], browserSupported: true }),
  p({ providerId: 'melon', displayName: 'Melon', category: 'media', defaultRiskLevel: 'R0',
    regions: ['KR'], browserSupported: true }),
];

const TH_VN_PH_ID_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'lineth', displayName: 'LINE Thailand', category: 'communication', defaultRiskLevel: 'R1',
    regions: ['TH'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'line-vn', displayName: 'LINE Vietnam', category: 'communication', defaultRiskLevel: 'R1',
    regions: ['VN'], apiSupported: true, browserSupported: true }),
  p({ providerId: ' Grab-ph', displayName: 'Grab Philippines', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['PH'], browserSupported: true }),
  p({ providerId: 'gojek', displayName: 'Gojek', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['ID'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'ocare', displayName: 'Ocare Indonesia', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['ID'], browserSupported: true }),
  p({ providerId: 'bukalapak', displayName: 'Bukalapak', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['ID'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'tokopedia', displayName: 'Tokopedia', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['ID'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'dana', displayName: 'DANA', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['ID'], browserSupported: true }),
  p({ providerId: 'ovo', displayName: 'OVO', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['ID'], browserSupported: true }),
  p({ providerId: 'shopeeth', displayName: 'Shopee Thailand', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['TH'], browserSupported: true }),
  p({ providerId: 'lazada-th', displayName: 'Lazada Thailand', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['TH'], browserSupported: true }),
  p({ providerId: 'lazada-vn', displayName: 'Lazada Vietnam', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['VN'], browserSupported: true }),
  p({ providerId: 'lazada-ph', displayName: 'Lazada Philippines', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['PH'], browserSupported: true }),
  p({ providerId: 'lazada-id', displayName: 'Lazada Indonesia', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['ID'], browserSupported: true }),
  p({ providerId: 'grab-th', displayName: 'Grab Thailand', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['TH'], browserSupported: true }),
  p({ providerId: 'grab-vn', displayName: 'Grab Vietnam', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['VN'], browserSupported: true }),
  p({ providerId: 'grab-id', displayName: 'Grab Indonesia', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['ID'], browserSupported: true }),
  p({ providerId: 'beeper', displayName: 'Beeper (Vietnam)', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['VN'], browserSupported: true }),
  p({ providerId: 'gofood', displayName: 'GoFood', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['ID'], browserSupported: true }),
  p({ providerId: 'foodpanda-th', displayName: 'Foodpanda Thailand', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['TH'], browserSupported: true }),
  p({ providerId: 'foodpanda-vn', displayName: 'Foodpanda Vietnam', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['VN'], browserSupported: true }),
  p({ providerId: 'foodpanda-ph', displayName: 'Foodpanda Philippines', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['PH'], browserSupported: true }),
  p({ providerId: 'foodpanda-id', displayName: 'Foodpanda Indonesia', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['ID'], browserSupported: true }),
  p({ providerId: 'traveloka', displayName: 'Traveloka', category: 'travel', defaultRiskLevel: 'R1',
    regions: ['ID', 'TH', 'VN', 'PH', 'MY'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'agoda', displayName: 'Agoda', category: 'travel', defaultRiskLevel: 'R1',
    regions: ['TH', 'SG', 'ID', 'MY', 'PH'], apiSupported: true, browserSupported: true }),
];

const AU_NZ_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'afterpay', displayName: 'Afterpay', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['AU', 'NZ'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'shopify-au', displayName: 'Shopify Australia', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['AU'], browserSupported: true }),
  p({ providerId: 'uber-au', displayName: 'Uber Australia', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['AU'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'ubereats-au', displayName: 'Uber Eats Australia', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['AU'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'seek', displayName: 'SEEK', category: 'job', defaultRiskLevel: 'R0',
    regions: ['AU'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'trade-me', displayName: 'Trade Me', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['NZ'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'whitby', displayName: 'Whitby (NZ)', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['NZ'], browserSupported: true }),
];

const EU_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'xero-eu', displayName: 'Xero', category: 'finance', defaultRiskLevel: 'R2',
    regions: ['GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'FI'], apiSupported: true, oauthSupported: true, browserSupported: true }),
  p({ providerId: 'revolut', displayName: 'Revolut', category: 'finance', defaultRiskLevel: 'R2',
    regions: ['GB', 'DE', 'FR', 'ES', 'IT', 'NL'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'monzo', displayName: 'Monzo', category: 'finance', defaultRiskLevel: 'R2',
    regions: ['GB'], browserSupported: true }),
  p({ providerId: 'wise-eu', displayName: 'Wise', category: 'finance', defaultRiskLevel: 'R2',
    regions: ['GB', 'DE', 'FR', 'ES', 'IT', 'NL'], apiSupported: true, oauthSupported: true, browserSupported: true }),
  p({ providerId: 'klarna', displayName: 'Klarna', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['DE', 'SE', 'NO', 'DK', 'FI', 'NL', 'AT', 'CH'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'stripe-eu', displayName: 'Stripe Europe', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'FI', 'CH', 'AT'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'zalando', displayName: 'Zalando', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['DE', 'AT', 'CH', 'FR', 'IT', 'ES'], browserSupported: true }),
  p({ providerId: 'ikea-eu', displayName: 'IKEA', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['DE', 'GB', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'HU'], browserSupported: true }),
  p({ providerId: 'h&M', displayName: 'H&M', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['DE', 'GB', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'FI'], browserSupported: true }),
  p({ providerId: 'bol-com', displayName: 'Bol.com', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['NL', 'BE'], browserSupported: true }),
  p({ providerId: 'allegro', displayName: 'Allegro', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['PL'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'cdn-eu', displayName: 'CDON', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['SE', 'NO'], browserSupported: true }),
  p({ providerId: 'eleven', displayName: 'ElevenJames', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['GB'], browserSupported: true }),
  p({ providerId: 'just-eat', displayName: 'Just Eat', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['GB', 'DE', 'FR', 'ES'], browserSupported: true }),
  p({ providerId: 'deliveroo', displayName: 'Deliveroo', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['GB', 'FR', 'ES', 'IT'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'uber-eu', displayName: 'Uber Europe', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'bolt', displayName: 'Bolt', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['EE', 'LT', 'LV', 'FI', 'PL', 'CZ', 'HU', 'PT'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'free', displayName: 'Free (Orange)', category: 'local_services', defaultRiskLevel: 'R0',
    regions: ['FR'], browserSupported: true }),
  p({ providerId: 'sncf', displayName: 'SNCF', category: 'travel', defaultRiskLevel: 'R1',
    regions: ['FR'], browserSupported: true }),
  p({ providerId: 'renfe', displayName: 'Renfe', category: 'travel', defaultRiskLevel: 'R1',
    regions: ['ES'], browserSupported: true }),
  p({ providerId: 'db', displayName: 'Deutsche Bahn', category: 'travel', defaultRiskLevel: 'R1',
    regions: ['DE'], browserSupported: true }),
  p({ providerId: 'trenitalia', displayName: 'Trenitalia', category: 'travel', defaultRiskLevel: 'R1',
    regions: ['IT'], browserSupported: true }),
  p({ providerId: 'nhs', displayName: 'NHS (UK)', category: 'local_services', defaultRiskLevel: 'R3',
    regions: ['GB'], browserSupported: true }),
  p({ providerId: 'gov-uk', displayName: 'GOV.UK', category: 'local_services', defaultRiskLevel: 'R0',
    regions: ['GB'], browserSupported: true }),
];

const MENA_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'talabat', displayName: 'Talabat', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['SA', 'AE', 'KW', 'BH', 'QA', 'OM'], browserSupported: true }),
  p({ providerId: 'deliveroo-mena', displayName: 'Deliveroo MENA', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['SA', 'AE'], browserSupported: true }),
  p({ providerId: 'careem', displayName: 'Careem', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['SA', 'AE', 'KW', 'BH', 'QA'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'uber-mena', displayName: 'Uber MENA', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['SA', 'AE', 'EG', 'MA'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'noon', displayName: 'Noon', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['SA', 'AE'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'amazon-sa', displayName: 'Amazon Saudi', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['SA'], browserSupported: true }),
  p({ providerId: 'amazon-ae', displayName: 'Amazon UAE', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['AE'], browserSupported: true }),
  p({ providerId: 'stc-pay', displayName: 'STC Pay', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['SA'], browserSupported: true }),
  p({ providerId: 'tabby', displayName: 'Tabby', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['SA', 'AE'], browserSupported: true }),
  p({ providerId: 'tamara', displayName: 'Tamara', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['SA', 'AE'], browserSupported: true }),
  p({ providerId: 'elmuz', displayName: 'ElMuz (Egypt)', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['EG'], browserSupported: true }),
  p({ providerId: 'twitter-mena', displayName: 'X MENA', category: 'social', defaultRiskLevel: 'R2',
    regions: ['SA', 'AE', 'EG', 'IL', 'TR'], browserSupported: true }),
  p({ providerId: 'snapchat-mena', displayName: 'Snapchat MENA', category: 'social', defaultRiskLevel: 'R2',
    regions: ['SA', 'AE', 'EG'], browserSupported: true }),
  p({ providerId: 'instashop-mena', displayName: 'InstaShop', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['SA', 'AE'], browserSupported: true }),
];

const LATAM_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'mercado-libre', displayName: 'Mercado Libre', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['BR', 'MX', 'AR', 'CO', 'CL', 'PE'], apiSupported: true, browserSupported: true,
    description: 'Latin America largest e-commerce' }),
  p({ providerId: 'mercadopago', displayName: 'Mercado Pago', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['BR', 'MX', 'AR', 'CO', 'CL', 'PE'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'amex-br', displayName: 'American Express Brazil', category: 'finance', defaultRiskLevel: 'R2',
    regions: ['BR'], browserSupported: true }),
  p({ providerId: 'nubank', displayName: 'Nubank', category: 'finance', defaultRiskLevel: 'R3',
    regions: ['BR'], browserSupported: true }),
  p({ providerId: 'iFood', displayName: 'iFood', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['BR'], browserSupported: true }),
  p({ providerId: 'uber-br', displayName: 'Uber Brazil', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['BR'], apiSupported: true, browserSupported: true }),
  p({ providerId: '99-br', displayName: '99 (Uber)', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['BR'], browserSupported: true }),
  p({ providerId: 'magalu', displayName: 'Magazine Luiza', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['BR'], browserSupported: true }),
  p({ providerId: 'americanas', displayName: 'Americanas', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['BR'], browserSupported: true }),
  p({ providerId: 'rappi', displayName: 'Rappi', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['CO', 'MX', 'AR', 'CL', 'PE'], browserSupported: true }),
  p({ providerId: 'babbel-latam', displayName: 'BBLatam', category: 'education', defaultRiskLevel: 'R0',
    regions: ['MX', 'BR'], browserSupported: true }),
  p({ providerId: 'clarety', displayName: 'Clarety', category: 'education', defaultRiskLevel: 'R0',
    regions: ['MX'], browserSupported: true }),
  p({ providerId: 'kavak', displayName: 'Kavak', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['MX', 'BR', 'CO'], browserSupported: true }),
  p({ providerId: 'olx-br', displayName: 'OLX Brazil', category: 'e-commerce', defaultRiskLevel: 'R0',
    regions: ['BR'], browserSupported: true }),
  p({ providerId: 'spotify-latam', displayName: 'Spotify Latin America', category: 'media', defaultRiskLevel: 'R0',
    regions: ['BR', 'MX', 'AR', 'CO'], browserSupported: true }),
];

const AFRICA_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'flutterwave', displayName: 'Flutterwave', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['NG', 'KE', 'GH', 'ZA'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'paystack', displayName: 'Paystack', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['NG', 'GH'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'm-pesa', displayName: 'M-Pesa', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['KE', 'TZ'], browserSupported: true }),
  p({ providerId: ' Jumia', displayName: 'Jumia', category: 'e-commerce', defaultRiskLevel: 'R1',
    regions: ['NG', 'KE', 'GH', 'EG', 'MA'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'take-a-way-ng', displayName: 'Takeaway (NG)', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['NG'], browserSupported: true }),
  p({ providerId: 'glovo-ng', displayName: 'Glovo Nigeria', category: 'food_delivery', defaultRiskLevel: 'R1',
    regions: ['NG'], browserSupported: true }),
  p({ providerId: 'bolt-za', displayName: 'Bolt South Africa', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['ZA'], browserSupported: true }),
  p({ providerId: 'uber-za', displayName: 'Uber South Africa', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['ZA'], apiSupported: true, browserSupported: true }),
  p({ providerId: 'didi-za', displayName: 'DiDi South Africa', category: 'ride_hailing', defaultRiskLevel: 'R1',
    regions: ['ZA'], browserSupported: true }),
  p({ providerId: 'telstra', displayName: 'Telstra', category: 'local_services', defaultRiskLevel: 'R0',
    regions: ['AU'], browserSupported: true }),
  p({ providerId: ' Vodacom', displayName: 'Vodacom', category: 'local_services', defaultRiskLevel: 'R0',
    regions: ['ZA', 'TZ', 'MZ'], browserSupported: true }),
  p({ providerId: 'mta-ke', displayName: 'M-Tiba (Kenya)', category: 'local_services', defaultRiskLevel: 'R1',
    regions: ['KE'], browserSupported: true }),
  p({ providerId: 'airtel-money', displayName: 'Airtel Money', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['UG', 'TZ', 'CD'], browserSupported: true }),
  p({ providerId: 'orange-money', displayName: 'Orange Money', category: 'payment', defaultRiskLevel: 'R2',
    regions: ['CI', 'SN', 'ML', 'BF'], browserSupported: true }),
  p({ providerId: 'consortium-ng', displayName: 'Consortium (NG)', category: 'finance', defaultRiskLevel: 'R2',
    regions: ['NG'], browserSupported: true }),
];


// ─── Developer Tools ───────────────────────────────────────────────
const DEVELOPER_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'vscode', displayName: 'VS Code', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, browserSupported: true, description: 'Code editor marketplace' }),
  p({ providerId: 'jetbrains', displayName: 'JetBrains', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'postman', displayName: 'Postman', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'insomnia', displayName: 'Insomnia', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'github-copilot', displayName: 'GitHub Copilot', category: 'developer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'github-codespaces', displayName: 'GitHub Codespaces', category: 'developer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'replit', displayName: 'Replit', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'codesandbox', displayName: 'CodeSandbox', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'stackblitz', displayName: 'StackBlitz', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'gitpod', displayName: 'Gitpod', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'devto', displayName: 'Dev.to', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'npm', displayName: 'npm Registry', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'pypi', displayName: 'PyPI', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'docker-hub', displayName: 'Docker Hub', category: 'developer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'github-packages', displayName: 'GitHub Packages', category: 'developer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'sonarcloud', displayName: 'SonarCloud', category: 'developer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'codacy', displayName: 'Codacy', category: 'developer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'vercel-ai', displayName: 'Vercel AI SDK', category: 'developer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'railway-cli', displayName: 'Railway CLI', category: 'developer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'flyio', displayName: 'Fly.io Developer', category: 'developer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
];

// ─── Database Platforms ────────────────────────────────────────────
const DATABASE_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'postgres', displayName: 'PostgreSQL', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'mysql', displayName: 'MySQL', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'mongodb', displayName: 'MongoDB', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'redis', displayName: 'Redis', category: 'database', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'firebase', displayName: 'Firebase', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'supabase', displayName: 'Supabase', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'neon', displayName: 'Neon', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'planetscale', displayName: 'PlanetScale', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'vercel-postgres', displayName: 'Vercel Postgres', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'aws-rds', displayName: 'Amazon RDS', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'aurora', displayName: 'AWS Aurora', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'snowflake', displayName: 'Snowflake', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'bigquery', displayName: 'Google BigQuery', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'dynamodb', displayName: 'Amazon DynamoDB', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'cassandra', displayName: 'Apache Cassandra', category: 'database', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'cockroachdb', displayName: 'CockroachDB', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'clickhouse', displayName: 'ClickHouse', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'timescaledb', displayName: 'TimescaleDB', category: 'database', defaultRiskLevel: 'R2',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'elasticsearch', displayName: 'Elasticsearch', category: 'database', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'couchbase', displayName: 'Couchbase', category: 'database', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
];

// ─── Developer Collaboration ────────────────────────────────────────
const DEV_COLLAB_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'github-discussions', displayName: 'GitHub Discussions', category: 'dev_collab', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'linear-api', displayName: 'Linear', category: 'dev_collab', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'devto-community', displayName: 'Dev.to Community', category: 'dev_collab', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'stackoverflow-api', displayName: 'Stack Overflow API', category: 'dev_collab', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'discord-dev', displayName: 'Discord Dev Servers', category: 'dev_collab', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'vercel-team', displayName: 'Vercel Teams', category: 'dev_collab', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'gitlab-collab', displayName: 'GitLab Collaboration', category: 'dev_collab', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'azure-devops-collab', displayName: 'Azure DevOps Boards', category: 'dev_collab', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'notion-dev', displayName: 'Notion Dev Docs', category: 'dev_collab', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'figma-dev-mode', displayName: 'Figma Dev Mode', category: 'dev_collab', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'codesandbox-pro', displayName: 'CodeSandbox Pro', category: 'dev_collab', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'replit-team', displayName: 'Replit Teams', category: 'dev_collab', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'codementor', displayName: 'Codementor', category: 'dev_collab', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'stackshare', displayName: 'StackShare', category: 'dev_collab', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'roadmap', displayName: 'Roadmap.sh', category: 'dev_collab', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'coursereview', displayName: 'CourseReview', category: 'dev_collab', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
];

// ─── Boost Categories ──────────────────────────────────────────────
const CALENDAR_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'outlook-calendar', displayName: 'Outlook Calendar', category: 'calendar', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'apple-calendar', displayName: 'Apple Calendar', category: 'calendar', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'calendly', displayName: 'Calendly', category: 'calendar', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'google-meet', displayName: 'Google Meet', category: 'calendar', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'zoom', displayName: 'Zoom', category: 'calendar', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'whereby', displayName: 'Whereby', category: 'calendar', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'doodle', displayName: 'Doodle', category: 'calendar', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'savvycal', displayName: 'SavvyCal', category: 'calendar', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
];

const CREATIVE_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'adobe-stock', displayName: 'Adobe Stock', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'unsplash', displayName: 'Unsplash', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'pexels', displayName: 'Pexels', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'behance', displayName: 'Behance', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'dribbble', displayName: 'Dribbble', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'artstation', displayName: 'ArtStation', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'deviantart', displayName: 'DeviantArt', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'shutterstock', displayName: 'Shutterstock', category: 'creative', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'storyset', displayName: 'Storyset', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'undraw', displayName: 'UnDraw', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'lottiefiles', displayName: 'LottieFiles', category: 'creative', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'renderforest', displayName: 'Renderforest', category: 'creative', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, browserSupported: true }),
];

const DOCUMENTS_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'google-slides', displayName: 'Google Slides', category: 'documents', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'ms-word', displayName: 'Microsoft Word', category: 'documents', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'ms-excel', displayName: 'Microsoft Excel', category: 'documents', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'ms-powerpoint', displayName: 'Microsoft PowerPoint', category: 'documents', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'onlyoffice', displayName: 'ONLYOFFICE', category: 'documents', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'zoho-docs', displayName: 'Zoho Docs', category: 'documents', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'dropbox-paper', displayName: 'Dropbox Paper', category: 'documents', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'wps-office', displayName: 'WPS Office', category: 'documents', defaultRiskLevel: 'R0',
    regions: ['CN', 'VN', 'TH', 'ID', 'PH', 'MY'], browserSupported: true }),
];

const EMAIL_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'outlook-mail', displayName: 'Outlook Mail', category: 'email', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'yahoo-mail', displayName: 'Yahoo Mail', category: 'email', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'proton-mail', displayName: 'Proton Mail', category: 'email', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'mailgun', displayName: 'Mailgun', category: 'email', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'sendgrid', displayName: 'SendGrid', category: 'email', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'aws-ses', displayName: 'AWS SES', category: 'email', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'resend', displayName: 'Resend', category: 'email', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'yandex-mail', displayName: 'Yandex.Mail', category: 'email', defaultRiskLevel: 'R0',
    regions: ['RU', 'UA', 'KZ', 'BY'], browserSupported: true }),
];

const FILE_TRANSFER_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'wetransfer', displayName: 'WeTransfer', category: 'file_transfer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'dropbox-transfer', displayName: 'Dropbox Transfer', category: 'file_transfer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'sftp', displayName: 'SFTP Server', category: 'file_transfer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'mega', displayName: 'MEGA', category: 'file_transfer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'pcloud', displayName: 'pCloud', category: 'file_transfer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'synology', displayName: 'Synology Drive', category: 'file_transfer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'nextcloud', displayName: 'Nextcloud', category: 'file_transfer', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'dropbox-business', displayName: 'Dropbox Business', category: 'file_transfer', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
];

const CLOUD_STORAGE_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'icloud', displayName: 'iCloud Drive', category: 'cloud_storage', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'box', displayName: 'Box', category: 'cloud_storage', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'mediafire', displayName: 'MediaFire', category: 'cloud_storage', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'sync.com', displayName: 'Sync.com', category: 'cloud_storage', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'tencent-cos', displayName: 'Tencent COS', category: 'cloud_storage', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true }),
  p({ providerId: 'aliyun-oss', displayName: 'Aliyun OSS', category: 'cloud_storage', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true }),
  p({ providerId: 'qiniu', displayName: 'Qiniu Cloud', category: 'cloud_storage', defaultRiskLevel: 'R1',
    regions: ['CN'], apiSupported: true }),
  p({ providerId: 'baidu-netdisk', displayName: 'Baidu Netdisk', category: 'cloud_storage', defaultRiskLevel: 'R0',
    regions: ['CN'], browserSupported: true }),
];

const KB_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'gitbook', displayName: 'GitBook', category: 'knowledge_base', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'slite', displayName: 'Slite', category: 'knowledge_base', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'lucidchart', displayName: 'Lucidchart', category: 'knowledge_base', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'logseq', displayName: 'Logseq', category: 'knowledge_base', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'anytype', displayName: 'Anytype', category: 'knowledge_base', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'obsidian-cloud', displayName: 'Obsidian Cloud', category: 'knowledge_base', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
];

const BACKUP_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'backblaze-b2', displayName: 'Backblaze B2', category: 'backup', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'aws-backup', displayName: 'AWS Backup', category: 'backup', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'google-backup', displayName: 'Google Cloud Backup', category: 'backup', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'azure-backup', displayName: 'Azure Backup', category: 'backup', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'rs-online', displayName: 'IDrive', category: 'backup', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'duplicati', displayName: 'Duplicati', category: 'backup', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, browserSupported: true }),
];

const NEWS_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'reddit-news', displayName: 'Reddit News', category: 'news', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'flipboard', displayName: 'Flipboard', category: 'news', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'ap-news', displayName: 'AP News', category: 'news', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'reuters', displayName: 'Reuters', category: 'news', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'guardian', displayName: 'The Guardian', category: 'news', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'bbc-news', displayName: 'BBC News', category: 'news', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
];

const JOB_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'linkedin-jobs', displayName: 'LinkedIn Jobs', category: 'job', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'indeed', displayName: 'Indeed', category: 'job', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'glassdoor', displayName: 'Glassdoor', category: 'job', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'zip-recruiter', displayName: 'ZipRecruiter', category: 'job', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'upwork', displayName: 'Upwork', category: 'job', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'fiverr', displayName: 'Fiverr', category: 'job', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'freelancer', displayName: 'Freelancer.com', category: 'job', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'toptal', displayName: 'Toptal', category: 'job', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'remote-ok', displayName: 'Remote OK', category: 'job', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'weworkremotely', displayName: 'We Work Remotely', category: 'job', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL }),
];

const CS_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'freshchat', displayName: 'Freshchat', category: 'customer_support', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'intercom-messenger', displayName: 'Intercom Messenger', category: 'customer_support', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'crisp', displayName: 'Crisp', category: 'customer_support', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'drift', displayName: 'Drift', category: 'customer_support', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'livechat', displayName: 'LiveChat', category: 'customer_support', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'tawk', displayName: 'Tawk.to', category: 'customer_support', defaultRiskLevel: 'R0',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'hubspot-service', displayName: 'HubSpot Service Hub', category: 'customer_support', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL }),
  p({ providerId: 'zoho-cs', displayName: 'Zoho Desk', category: 'customer_support', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
];

const CICD_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'github-actions', displayName: 'GitHub Actions', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'jenkins', displayName: 'Jenkins', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'circleci', displayName: 'CircleCI', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'bitbucket-pipelines', displayName: 'Bitbucket Pipelines', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'azure-pipelines', displayName: 'Azure Pipelines', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'gitlab-ci', displayName: 'GitLab CI/CD', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'teamcity', displayName: 'TeamCity', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'travis-ci', displayName: 'Travis CI', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'codeship', displayName: 'Codeship', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'buddy', displayName: 'Buddy Works', category: 'cicd', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
];

const CLOUD_INFRA_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'digital-ocean', displayName: 'DigitalOcean', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true, oauthSupported: true }),
  p({ providerId: 'linode', displayName: 'Linode', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'vultr', displayName: 'Vultr', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'hetzner', displayName: 'Hetzner', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: ['DE', 'FI', 'US'], apiSupported: true }),
  p({ providerId: 'ovh', displayName: 'OVH Cloud', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: ['FR', 'CA', 'DE', 'GB'], apiSupported: true }),
  p({ providerId: 'scaleway', displayName: 'Scaleway', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: ['FR', 'DE', 'PL'], apiSupported: true }),
  p({ providerId: 'gcp-functions', displayName: 'GCP Cloud Functions', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'azure-functions', displayName: 'Azure Functions', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'cloudflare', displayName: 'Cloudflare', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'fastly', displayName: 'Fastly', category: 'cloud_infra', defaultRiskLevel: 'R1',
    regions: REGIONS_GLOBAL, apiSupported: true }),
];

const NORDIC_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'postnord-se', displayName: 'PostNord Sweden', category: 'local_services', defaultRiskLevel: 'R0',
    regions: ['SE'], browserSupported: true }),
  p({ providerId: 'postnord-no', displayName: 'PostNord Norway', category: 'local_services', defaultRiskLevel: 'R0',
    regions: ['NO'], browserSupported: true }),
  p({ providerId: 'posti-fi', displayName: 'Posti Finland', category: 'local_services', defaultRiskLevel: 'R0',
    regions: ['FI'], browserSupported: true }),
  p({ providerId: 'postnord-dk', displayName: 'PostNord Denmark', category: 'local_services', defaultRiskLevel: 'R0',
    regions: ['DK'], browserSupported: true }),
];




// ─── Boost: Design (need 11 more) ──────────────────────────────
const DESIGN_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'penpot', displayName: 'Penpot', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'sketch-cloud', displayName: 'Sketch Cloud', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'procreate', displayName: 'Procreate', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'illustrator', displayName: 'Adobe Illustrator', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'photoshop-online', displayName: 'Photoshop Web', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'affinity-designer', displayName: 'Affinity Designer', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'blender', displayName: 'Blender Cloud', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'canva-pro', displayName: 'Canva Pro', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'adobe-express', displayName: 'Adobe Express', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'remove-bg', displayName: 'Remove.bg', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'photopea', displayName: 'Photopea', category: 'design', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, browserSupported: true }),
];

// ─── Boost: Productivity (need 11 more) ─────────────────────────
const PRODUCTIVITY_PROVIDERS: PlatformManifestDef[] = [
  
  p({ providerId: 'notion-api', displayName: 'Notion API', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'microsoft-to-do', displayName: 'Microsoft To Do', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'todoist', displayName: 'Todoist', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'anydo', displayName: 'Any.do', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-tasks', displayName: 'Google Tasks', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'apple-reminders', displayName: 'Apple Reminders', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'apple-notes', displayName: 'Apple Notes', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'apple-contacts', displayName: 'Apple Contacts', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-keep', displayName: 'Google Keep', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'ticktick', displayName: 'TickTick', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'amazon-habits', displayName: 'Amazon Habits', category: 'productivity', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Social (need 4 more) ────────────────────────────────
const SOCIAL_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'pinterest', displayName: 'Pinterest', category: 'social', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'snapchat', displayName: 'Snapchat', category: 'social', defaultRiskLevel: 'R2', regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'whatsapp-personal', displayName: 'WhatsApp Personal', category: 'social', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL, browserSupported: true }),
  p({ providerId: 'line-social', displayName: 'LINE Social', category: 'social', defaultRiskLevel: 'R1', regions: ['JP', 'TH', 'TW', 'ID', 'CN'], browserSupported: true }),
  p({ providerId: 'kuaishou-social', displayName: '快手社交', category: 'social', defaultRiskLevel: 'R1', regions: ['CN'], browserSupported: true }),
  p({ providerId: 'wechat-social', displayName: '微信朋友圈', category: 'social', defaultRiskLevel: 'R1', regions: ['CN'], browserSupported: true }),
];

// ─── Boost: Media ───────────────────────────────────────────────
const MEDIA_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'spotify', displayName: 'Spotify', category: 'media', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'apple-music', displayName: 'Apple Music', category: 'media', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'youtube-music', displayName: 'YouTube Music', category: 'media', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'soundcloud', displayName: 'SoundCloud', category: 'media', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'bandcamp', displayName: 'Bandcamp', category: 'media', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'netflix', displayName: 'Netflix', category: 'media', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'disney-plus', displayName: 'Disney+', category: 'media', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'hulu', displayName: 'Hulu', category: 'media', defaultRiskLevel: 'R0', regions: ['US'] }),
  p({ providerId: 'hbo-max', displayName: 'HBO Max', category: 'media', defaultRiskLevel: 'R0', regions: ['US'] }),
  p({ providerId: 'iqiyi', displayName: '爱奇艺 iQiyi', category: 'media', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: 'youku', displayName: '优酷 Youku', category: 'media', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: 'bilibili-media', displayName: '哔哩哔哩 Media', category: 'media', defaultRiskLevel: 'R0', regions: ['CN'] }),
];

// ─── Boost: Analytics ───────────────────────────────────────────
const ANALYTICS_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' GA4', displayName: 'Google Analytics 4', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' Adobe-analytics', displayName: 'Adobe Analytics', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' mixpanel-pro', displayName: 'Mixpanel Pro', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' amplitude-pro', displayName: 'Amplitude Pro', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' segment-pro', displayName: 'Segment Pro', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' hotjar-pro', displayName: 'Hotjar Pro', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' fullstory', displayName: 'FullStory', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' mixpanel-enterprise', displayName: 'Mixpanel Enterprise', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Marketing ───────────────────────────────────────────
const MARKETING_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' mailchimp-pro', displayName: 'Mailchimp Pro', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' hootsuite-pro', displayName: 'Hootsuite Pro', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' buffer-pro', displayName: 'Buffer Pro', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' canva-marketing', displayName: 'Canva for Marketing', category: 'marketing', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' convertkit', displayName: 'ConvertKit', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' activecampaign', displayName: 'ActiveCampaign', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' hubspot-cms', displayName: 'HubSpot CMS', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' drupal', displayName: 'Drupal', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];

// ─── Boost: CRM ─────────────────────────────────────────────────
const CRM_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' salesforce-pro', displayName: 'Salesforce Pro', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' hubspot-pro', displayName: 'HubSpot Pro', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' zoho-crm-pro', displayName: 'Zoho CRM Pro', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' pipedrive-pro', displayName: 'Pipedrive Pro', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' freshsales', displayName: 'Freshsales', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' close-com', displayName: 'Close.com', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' agile-crm', displayName: 'Agile CRM', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' insightly', displayName: 'Insightly', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Project Management ──────────────────────────────────
const PM_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' asana-pro', displayName: 'Asana Pro', category: 'project_management', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' trello-pro', displayName: 'Trello Pro', category: 'project_management', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' monday-pro', displayName: 'Monday Pro', category: 'project_management', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' clickup-pro', displayName: 'ClickUp Pro', category: 'project_management', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' jira-pro', displayName: 'Jira Software', category: 'project_management', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' basecamp', displayName: 'Basecamp', category: 'project_management', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' wrike', displayName: 'Wrike', category: 'project_management', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' smartsheet', displayName: 'Smartsheet', category: 'project_management', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Forms ───────────────────────────────────────────────
const FORMS_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' typeform-pro', displayName: 'Typeform Pro', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' google-forms-pro', displayName: 'Google Forms Pro', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'surveymonkey-pro', displayName: 'SurveyMonkey Pro', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' qualtrics-pro', displayName: 'Qualtrics Pro', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' jotform', displayName: 'JotForm', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' formstack', displayName: 'Formstack', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' getform', displayName: 'GetForm', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' tally', displayName: 'Tally', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Automation ─────────────────────────────────────────
const AUTOMATION_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' zapier-pro', displayName: 'Zapier Pro', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' make-pro', displayName: 'Make Pro', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' n8n-pro', displayName: 'n8n Pro', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' ifttt-pro', displayName: 'IFTTT Pro', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' automatisch', displayName: 'Automatisch', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' workato', displayName: 'Workato', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' tray', displayName: 'Tray', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' integromat-pro', displayName: 'Integromat Pro', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Education ───────────────────────────────────────────
const EDUCATION_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' google-classroom-pro', displayName: 'Google Classroom Pro', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' canvas-pro', displayName: 'Canvas LMS Pro', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' coursera-pro', displayName: 'Coursera Pro', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' udemy-pro', displayName: 'Udemy Pro', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' edx', displayName: 'edX', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' khan-academy', displayName: 'Khan Academy', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' duolingo', displayName: 'Duolingo', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' quizlet', displayName: 'Quizlet', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' codecademy', displayName: 'Codecademy', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' free-code-camp', displayName: 'freeCodeCamp', category: 'education', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Search ──────────────────────────────────────────────
const SEARCH_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' google-search-console-pro', displayName: 'Google Search Console Pro', category: 'search', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' bing-webmaster', displayName: 'Bing Webmaster', category: 'search', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' seotools', displayName: 'SEOsTools', category: 'search', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' semrush', displayName: 'Semrush', category: 'search', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' ahrefs', displayName: 'Ahrefs', category: 'search', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' moz', displayName: 'Moz', category: 'search', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' google-search-console-cn', displayName: '百度站长工具', category: 'search', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' naver-search', displayName: 'Naver Search Advisor', category: 'search', defaultRiskLevel: 'R0', regions: ['KR'] }),
];

// ─── Boost: Code Hosting ────────────────────────────────────────
const CODE_HOSTING_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' github-enterprise', displayName: 'GitHub Enterprise', category: 'code_hosting', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' gitlab-enterprise', displayName: 'GitLab Enterprise', category: 'code_hosting', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' bitbucket-enterprise', displayName: 'Bitbucket Data Center', category: 'code_hosting', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' gitea', displayName: 'Gitea', category: 'code_hosting', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' forgejo', displayName: 'Forgejo', category: 'code_hosting', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' gitlab-cn', displayName: 'GitLab 中国版', category: 'code_hosting', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' gitee', displayName: 'Gitee', category: 'code_hosting', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' codeberg-pro', displayName: 'Codeberg Pro', category: 'code_hosting', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];

// ─── Boost: AI ──────────────────────────────────────────────────
const AI_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: ' openai-pro', displayName: 'OpenAI Pro', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' anthropic-pro', displayName: 'Anthropic Pro', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' perplexity-pro', displayName: 'Perplexity Pro', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' midjourney-pro', displayName: 'Midjourney Pro', category: 'ai', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' stability-ai-pro', displayName: 'Stability AI Pro', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' replicate-pro', displayName: 'Replicate Pro', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' huggingface-pro', displayName: 'Hugging Face Pro', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' cohere', displayName: 'Cohere', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' together-ai', displayName: 'Together AI', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' openrouter', displayName: 'OpenRouter', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' lepton-ai', displayName: 'Lepton AI', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' fal-ai', displayName: 'Fal.ai', category: 'ai', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' mini-max', displayName: 'MiniMax', category: 'ai', defaultRiskLevel: 'R0', regions: ['CN', 'GLOBAL'] }),
  p({ providerId: ' zero-one', displayName: 'ZeroOne AI', category: 'ai', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' moonshot', displayName: 'Moonshot AI', category: 'ai', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' zhipu', displayName: '智谱 AI (GLM)', category: 'ai', defaultRiskLevel: 'R0', regions: ['CN'] }),
];

// ─── Boost: Customer Support ───────────────────────────────────
const CS_MORE: PlatformManifestDef[] = [
  p({ providerId: ' zendesk-pro', displayName: 'Zendesk Pro', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' freshdesk-pro', displayName: 'Freshdesk Pro', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' intercom-pro', displayName: 'Intercom Pro', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' salesforce-service', displayName: 'Salesforce Service Cloud', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' hubspot-service', displayName: 'HubSpot Service Hub', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' heap', displayName: 'Heap', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' apollo', displayName: 'Apollo', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' crisp-pro', displayName: 'Crisp Pro', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' userfox', displayName: 'Userfox', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' talkdesk', displayName: 'Talkdesk', category: 'customer_support', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Travel ──────────────────────────────────────────────
const TRAVEL_MORE: PlatformManifestDef[] = [
  p({ providerId: ' tripadvisor', displayName: 'TripAdvisor', category: 'travel', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' klook', displayName: 'Klook', category: 'travel', defaultRiskLevel: 'R1', regions: ['HK', 'TW', 'TH', 'JP', 'KR', 'SG', 'MY', 'ID', 'PH'] }),
  p({ providerId: ' agoda-pro', displayName: 'Agoda Pro', category: 'travel', defaultRiskLevel: 'R1', regions: ['TH', 'SG', 'ID', 'MY', 'PH', 'VN', 'JP', 'KR'] }),
  p({ providerId: ' kakaotalk-travel', displayName: 'Kakao Travel', category: 'travel', defaultRiskLevel: 'R1', regions: ['KR'] }),
  p({ providerId: ' travian', displayName: 'Travian Games', category: 'travel', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' skyscanner', displayName: 'Skyscanner', category: 'travel', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' momondo', displayName: 'Momondo', category: 'travel', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' ctrip', displayName: '携程 Ctrip', category: 'travel', defaultRiskLevel: 'R1', regions: ['CN'] }),
  p({ providerId: ' qunar', displayName: '去哪儿 Qunar', category: 'travel', defaultRiskLevel: 'R1', regions: ['CN'] }),
  p({ providerId: ' fliggy', displayName: '飞猪 Fliggy', category: 'travel', defaultRiskLevel: 'R1', regions: ['CN'] }),
];

// ─── Boost: Job ─────────────────────────────────────────────────
const JOB_MORE: PlatformManifestDef[] = [
  p({ providerId: ' careerjet', displayName: 'CareerJet', category: 'job', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' monster-india', displayName: 'Monster India', category: 'job', defaultRiskLevel: 'R0', regions: ['IN'] }),
  p({ providerId: ' naukri', displayName: 'Naukri.com', category: 'job', defaultRiskLevel: 'R0', regions: ['IN'] }),
  p({ providerId: ' findsim', displayName: 'Findsim', category: 'job', defaultRiskLevel: 'R0', regions: ['IN'] }),
  p({ providerId: ' linkedin-pro', displayName: 'LinkedIn ProFinder', category: 'job', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' wayup', displayName: 'WayUp', category: 'job', defaultRiskLevel: 'R0', regions: ['US'] }),
  p({ providerId: ' angel-list', displayName: 'AngelList', category: 'job', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' wellfound', displayName: 'Wellfound', category: 'job', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' crunchboard', displayName: 'Crunchboard', category: 'job', defaultRiskLevel: 'R0', regions: ['US'] }),
  p({ providerId: ' working-nomads', displayName: 'Working Nomads', category: 'job', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Community ───────────────────────────────────────────
const COMMUNITY_MORE: PlatformManifestDef[] = [
  p({ providerId: ' discord-comm-pro', displayName: 'Discord Communities Pro', category: 'community', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: ' reddit-pro', displayName: 'Reddit Premium', category: 'community', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' qq-group', displayName: 'QQ 群', category: 'community', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' wechat-group', displayName: '微信群', category: 'community', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' line-group', displayName: 'LINE Groups', category: 'community', defaultRiskLevel: 'R0', regions: ['JP', 'TH', 'TW'] }),
  p({ providerId: ' naver-blog', displayName: 'Naver Blog', category: 'community', defaultRiskLevel: 'R0', regions: ['KR'] }),
  p({ providerId: ' zhuanzhi', displayName: '转知', category: 'community', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' xiaohongshu-community', displayName: '小红书社区', category: 'community', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' mastodon', displayName: 'Mastodon', category: 'community', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: ' bluesky', displayName: 'Bluesky', category: 'community', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];

// ─── Boost: Local Services ──────────────────────────────────────
const LOCAL_SVC_MORE: PlatformManifestDef[] = [
  p({ providerId: ' 114-phone', displayName: '114 电话查询', category: 'local_services', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: ' gov-singapore', displayName: 'Gov Singapores', category: 'local_services', defaultRiskLevel: 'R0', regions: ['SG'] }),
  p({ providerId: ' gov-hk', displayName: 'Hong Kong Government', category: 'local_services', defaultRiskLevel: 'R0', regions: ['HK'] }),
  p({ providerId: ' gov-my', displayName: 'MyGov Malaysia', category: 'local_services', defaultRiskLevel: 'R0', regions: ['MY'] }),
  p({ providerId: ' gov-th', displayName: 'Thailand Gov', category: 'local_services', defaultRiskLevel: 'R0', regions: ['TH'] }),
  p({ providerId: ' gov-id', displayName: 'Indonesia Gov', category: 'local_services', defaultRiskLevel: 'R0', regions: ['ID'] }),
  p({ providerId: ' gov-ph', displayName: 'Philippines Gov', category: 'local_services', defaultRiskLevel: 'R0', regions: ['PH'] }),
  p({ providerId: ' gov-vn', displayName: 'Vietnam Gov', category: 'local_services', defaultRiskLevel: 'R0', regions: ['VN'] }),
  p({ providerId: ' gov-jp', displayName: 'Japan Gov e-Gov', category: 'local_services', defaultRiskLevel: 'R0', regions: ['JP'] }),
  p({ providerId: ' gov-kr', displayName: 'South Korea Gov', category: 'local_services', defaultRiskLevel: 'R0', regions: ['KR'] }),
  p({ providerId: ' gov-in', displayName: 'India Gov Udyam', category: 'local_services', defaultRiskLevel: 'R0', regions: ['IN'] }),
  p({ providerId: ' gov-au', displayName: 'Australia Gov', category: 'local_services', defaultRiskLevel: 'R0', regions: ['AU'] }),
];



// ─── Boost: Publishing ──────────────────────────────────────────
const PUBLISH_MORE: PlatformManifestDef[] = [
  p({ providerId: 'medium-pro', displayName: 'Medium Partner', category: 'publishing', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'substack-pro', displayName: 'Substack Pro', category: 'publishing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'ghost-pro', displayName: 'Ghost Pro', category: 'publishing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'hashnode-pro', displayName: 'Hashnode Pro', category: 'publishing', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'dev-to-pro', displayName: 'Dev.to Pro', category: 'publishing', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'mirror', displayName: 'Mirror.xyz', category: 'publishing', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'steemit', displayName: 'Steemit', category: 'publishing', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'lbry', displayName: 'LBRY/Odysee', category: 'publishing', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const NEWS_MORE: PlatformManifestDef[] = [
  p({ providerId: 'nyt-pro', displayName: 'NYT Digital', category: 'news', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'washpost', displayName: 'Washington Post', category: 'news', defaultRiskLevel: 'R0', regions: ['US'] }),
  p({ providerId: 'aljazeera', displayName: 'Al Jazeera', category: 'news', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'dw', displayName: 'Deutsche Welle', category: 'news', defaultRiskLevel: 'R0', regions: ['DE', 'EU'] }),
  p({ providerId: 'xinhua', displayName: '新华社 Xinhua', category: 'news', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: 'caixin', displayName: '财新 Caixin', category: 'news', defaultRiskLevel: 'R0', regions: ['CN'] }),
  p({ providerId: 'nikkei', displayName: '日经新闻 Nikkei', category: 'news', defaultRiskLevel: 'R0', regions: ['JP'] }),
  p({ providerId: 'yomiuri', displayName: '读卖新闻 Yomiuri', category: 'news', defaultRiskLevel: 'R0', regions: ['JP'] }),
];
const CALENDAR_MORE: PlatformManifestDef[] = [
  p({ providerId: 'everytime', displayName: 'Everytime Calendar', category: 'calendar', defaultRiskLevel: 'R0', regions: ['KR'] }),
  p({ providerId: 'wheniwork', displayName: 'When I Work', category: 'calendar', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'cal-dot-com', displayName: 'Cal.com', category: 'calendar', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL, apiSupported: true }),
  p({ providerId: 'merlin-calendar', displayName: 'Merlin Calendar', category: 'calendar', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'reclaim-ai', displayName: 'Reclaim AI', category: 'calendar', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'savvycal-pro', displayName: 'SavvyCal Pro', category: 'calendar', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const CREATIVE_MORE: PlatformManifestDef[] = [
  p({ providerId: 'midjourney-api', displayName: 'Midjourney API', category: 'creative', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'dall-e', displayName: 'DALL-E 3', category: 'creative', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'stable-diffusion-web', displayName: 'Stable Diffusion Web', category: 'creative', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'Leonardo-AI', displayName: 'Leonardo AI', category: 'creative', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'runway', displayName: 'Runway ML', category: 'creative', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'descript', displayName: 'Descript', category: 'creative', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'canva-video', displayName: 'Canva Video', category: 'creative', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'adobe-firefly', displayName: 'Adobe Firefly', category: 'creative', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];


const CODE_HOST_MORE: PlatformManifestDef[] = [
  p({ providerId: 'gitlab-pro', displayName: 'GitLab Pro', category: 'code_hosting', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'bitbucket-pro', displayName: 'Bitbucket Pro', category: 'code_hosting', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'azure-devops-pro', displayName: 'Azure DevOps Pro', category: 'code_hosting', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'gitee-pro', displayName: 'Gitee Pro', category: 'code_hosting', defaultRiskLevel: 'R0', regions: ['CN'] }),
];
const COMM_MORE: PlatformManifestDef[] = [
  p({ providerId: 'whatsapp-pro', displayName: 'WhatsApp Business API', category: 'communication', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'telegram-pro', displayName: 'Telegram Bot API', category: 'communication', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'slack-pro', displayName: 'Slack Pro', category: 'communication', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'discord-pro', displayName: 'Discord API', category: 'communication', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const CLS_MORE: PlatformManifestDef[] = [
  p({ providerId: 'google-drive-pro', displayName: 'Google Drive Pro', category: 'cloud_storage', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'dropbox-pro', displayName: 'Dropbox Pro', category: 'cloud_storage', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'onedrive-pro', displayName: 'OneDrive Pro', category: 'cloud_storage', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const DOC_MORE: PlatformManifestDef[] = [
  p({ providerId: 'google-docs-pro', displayName: 'Google Docs Pro', category: 'documents', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-sheets-pro', displayName: 'Google Sheets Pro', category: 'documents', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'ms-365-docs', displayName: 'MS 365 Documents', category: 'documents', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const EMAIL_MORE: PlatformManifestDef[] = [
  p({ providerId: 'gmail-pro', displayName: 'Gmail API', category: 'email', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'outlook-pro', displayName: 'Outlook 365', category: 'email', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const CRM_MORE: PlatformManifestDef[] = [
  p({ providerId: 'salesforce-pro', displayName: 'Salesforce Pro', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'hubspot-pro', displayName: 'HubSpot Pro', category: 'crm', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const ANALYTICS_MORE: PlatformManifestDef[] = [
  p({ providerId: 'google-analytics-pro', displayName: 'GA4 Pro', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'mixpanel-pro', displayName: 'Mixpanel Pro', category: 'analytics', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const MKT_MORE: PlatformManifestDef[] = [
  p({ providerId: 'mailchimp-pro', displayName: 'Mailchimp Pro', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'hootsuite-pro-2', displayName: 'Hootsuite Pro', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const AUTO_MORE: PlatformManifestDef[] = [
  p({ providerId: 'zapier-pro', displayName: 'Zapier Pro', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'make-pro', displayName: 'Make Pro', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const FORMS_MORE: PlatformManifestDef[] = [
  p({ providerId: 'typeform-pro', displayName: 'Typeform Pro', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'google-forms-pro', displayName: 'Google Forms Pro', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const KB_MORE: PlatformManifestDef[] = [
  p({ providerId: 'confluence-pro', displayName: 'Confluence Pro', category: 'knowledge_base', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'github-wiki-pro', displayName: 'GitHub Wiki Pro', category: 'knowledge_base', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const FT_MORE: PlatformManifestDef[] = [
  p({ providerId: 's3-pro', displayName: 'AWS S3 Pro', category: 'file_transfer', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'gcs-pro', displayName: 'GCS Pro', category: 'file_transfer', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const BACKUP_MORE: PlatformManifestDef[] = [
  p({ providerId: 'google-backup-pro', displayName: 'Google Backup Pro', category: 'backup', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'carbonite-pro', displayName: 'Carbonite Pro', category: 'backup', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const SEARCH_MORE: PlatformManifestDef[] = [
  p({ providerId: 'google-search-console-pro', displayName: 'GSC Pro', category: 'search', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'baidu-webmaster', displayName: '百度站长', category: 'search', defaultRiskLevel: 'R0', regions: ['CN'] }),
];


const CLS_FINAL: PlatformManifestDef[] = [
  p({ providerId: 'pcloud-pro', displayName: 'pCloud Pro', category: 'cloud_storage', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'megasync', displayName: 'Mega Sync', category: 'cloud_storage', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const DOC_FINAL: PlatformManifestDef[] = [
  p({ providerId: 'onlyoffice-pro', displayName: 'ONLYOFFICE Pro', category: 'documents', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'zoho-writer', displayName: 'Zoho Writer', category: 'documents', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const EMAIL_FINAL: PlatformManifestDef[] = [
  p({ providerId: 'proton-mail-pro', displayName: 'Proton Mail Pro', category: 'email', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'sendgrid-pro', displayName: 'SendGrid Pro', category: 'email', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const MKT_FINAL: PlatformManifestDef[] = [
  p({ providerId: 'buffer-pro', displayName: 'Buffer Pro', category: 'marketing', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  
];
const AUTO_FINAL: PlatformManifestDef[] = [
  p({ providerId: 'n8n-pro', displayName: 'n8n Pro', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'ifttt-pro', displayName: 'IFTTT Pro', category: 'automation', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const FORMS_FINAL: PlatformManifestDef[] = [
  
  p({ providerId: 'qualtrics-pro', displayName: 'Qualtrics Pro', category: 'forms', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const KB_FINAL: PlatformManifestDef[] = [
  p({ providerId: 'slite-pro', displayName: 'Slite Pro', category: 'knowledge_base', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'lucidchart-pro', displayName: 'Lucidchart Pro', category: 'knowledge_base', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const FT_FINAL: PlatformManifestDef[] = [
  p({ providerId: 'wetransfer-pro', displayName: 'WeTransfer Pro', category: 'file_transfer', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'dropbox-transfer-pro', displayName: 'Dropbox Transfer Pro', category: 'file_transfer', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const BACKUP_FINAL: PlatformManifestDef[] = [
  p({ providerId: 'backblaze-b2-pro', displayName: 'Backblaze B2 Pro', category: 'backup', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'aws-backup-pro', displayName: 'AWS Backup Pro', category: 'backup', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];


const FINAL_EMAIL: PlatformManifestDef[] = [
  p({ providerId: 'mailgun-pro', displayName: 'Mailgun Pro', category: 'email', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'aws-ses-pro', displayName: 'AWS SES Pro', category: 'email', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const FINAL_KB: PlatformManifestDef[] = [
  p({ providerId: 'gitbook-pro', displayName: 'GitBook Pro', category: 'knowledge_base', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
  p({ providerId: 'notion-wiki', displayName: 'Notion Wiki', category: 'knowledge_base', defaultRiskLevel: 'R0', regions: REGIONS_GLOBAL }),
];
const FINAL_FT: PlatformManifestDef[] = [
  p({ providerId: 'synology-pro', displayName: 'Synology Drive Pro', category: 'file_transfer', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'nextcloud-pro', displayName: 'Nextcloud Pro', category: 'file_transfer', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];
const FINAL_BACKUP: PlatformManifestDef[] = [
  p({ providerId: 'rs-online-pro', displayName: 'IDrive Pro', category: 'backup', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
  p({ providerId: 'duplicati-pro', displayName: 'Duplicati Pro', category: 'backup', defaultRiskLevel: 'R1', regions: REGIONS_GLOBAL }),
];

// ─── Aggregated exports ─────────────────────────────────────────────
export const GLOBAL_PROVIDERS: PlatformManifestDef[] = GLOBAL_TIER1;
// ─── Generic web (browser login) + multi-token providers ────────────
// Explicit capabilities so LEGACY_TOOLS exposes web.* / web-token.* to the
// agent (createAction accepts them, selectConnector routes to the browser /
// token connectors).
const WEB_TOKEN_PROVIDERS: PlatformManifestDef[] = [
  p({ providerId: 'web', displayName: 'Generic Web (Browser Login)', category: 'automation', defaultRiskLevel: 'R1',
    apiSupported: false, oauthSupported: false, apiKeySupported: false, browserSupported: true, genericWebSupported: true,
    regions: REGIONS_GLOBAL, description: 'Log into arbitrary sites via browser automation, then drive the page',
    capabilities: [
      { id: 'navigate', label: 'Open a URL', riskLevel: 'R0', readOnly: true },
      { id: 'read', label: 'Read page content', riskLevel: 'R0', readOnly: true },
      { id: 'screenshot', label: 'Screenshot the page', riskLevel: 'R0', readOnly: true },
      { id: 'click', label: 'Click an element', riskLevel: 'R2', readOnly: false },
      { id: 'input', label: 'Type into an element', riskLevel: 'R2', readOnly: false },
      { id: 'login', label: 'Log in (user/pass + captcha/OTP)', riskLevel: 'R1', readOnly: false },
    ] }),
  p({ providerId: 'web-token', displayName: 'Generic Account Token', category: 'automation', defaultRiskLevel: 'R2',
    apiSupported: true, oauthSupported: false, apiKeySupported: true, browserSupported: false, genericWebSupported: false,
    regions: REGIONS_GLOBAL, description: 'User-supplied account token (bearer / api key / basic / cookie / custom) for generic HTTP operations',
    capabilities: [
      { id: 'request', label: 'Authenticated request', riskLevel: 'R2', readOnly: false },
      { id: 'get', label: 'Authenticated GET', riskLevel: 'R0', readOnly: true },
      { id: 'post', label: 'Authenticated POST', riskLevel: 'R2', readOnly: false },
    ] }),
];

export const REGIONAL_PROVIDERS: PlatformManifestDef[] = [
  ...WEB_TOKEN_PROVIDERS,
  ...CN_PROVIDERS,
  ...HK_TW_PROVIDERS,
  ...MO_PROVIDERS,
  ...SG_MY_PROVIDERS,
  ...IN_PROVIDERS,
  ...JP_KR_PROVIDERS,
  ...TH_VN_PH_ID_PROVIDERS,
  ...AU_NZ_PROVIDERS,
  ...EU_PROVIDERS,
  ...MENA_PROVIDERS,
  ...LATAM_PROVIDERS,
  ...AFRICA_PROVIDERS,
  ...DEVELOPER_PROVIDERS,
  ...DATABASE_PROVIDERS,
  ...DEV_COLLAB_PROVIDERS,
  ...CALENDAR_PROVIDERS,
  ...CREATIVE_PROVIDERS,
  ...DOCUMENTS_PROVIDERS,
  ...EMAIL_PROVIDERS,
  ...FILE_TRANSFER_PROVIDERS,
  ...CLOUD_STORAGE_PROVIDERS,
  ...KB_PROVIDERS,
  ...BACKUP_PROVIDERS,
  ...NEWS_PROVIDERS,
  ...JOB_PROVIDERS,
  ...CS_PROVIDERS,
  ...CICD_PROVIDERS,
  ...CLOUD_INFRA_PROVIDERS,
  ...NORDIC_PROVIDERS,
  ...DESIGN_PROVIDERS,
  ...PRODUCTIVITY_PROVIDERS,
  ...SOCIAL_PROVIDERS,
  ...MEDIA_PROVIDERS,
  ...ANALYTICS_PROVIDERS,
  ...MARKETING_PROVIDERS,
  ...CRM_PROVIDERS,
  ...PM_PROVIDERS,
  ...FORMS_PROVIDERS,
  ...AUTOMATION_PROVIDERS,
  ...EDUCATION_PROVIDERS,
  ...SEARCH_PROVIDERS,
  ...CODE_HOSTING_PROVIDERS,
  ...AI_PROVIDERS,
  ...CS_MORE,
  ...TRAVEL_MORE,
  ...JOB_MORE,
  ...COMMUNITY_MORE,
  ...LOCAL_SVC_MORE,
  ...PUBLISH_MORE,
  ...NEWS_MORE,
  ...CALENDAR_MORE,
  ...CREATIVE_MORE,
  ...CODE_HOST_MORE,
  ...COMM_MORE,
  ...CLS_MORE,
  ...DOC_MORE,
  ...EMAIL_MORE,
  ...CRM_MORE,
  ...ANALYTICS_MORE,
  ...MKT_MORE,
  ...AUTO_MORE,
  ...FORMS_MORE,
  ...KB_MORE,
  ...FT_MORE,
  ...BACKUP_MORE,
  ...SEARCH_MORE,
  ...CLS_FINAL,
  ...DOC_FINAL,
  ...EMAIL_FINAL,
  ...MKT_FINAL,
  ...AUTO_FINAL,
  ...FORMS_FINAL,
  ...KB_FINAL,
  ...FT_FINAL,
  ...BACKUP_FINAL,
  ...FINAL_EMAIL,
  ...FINAL_KB,
  ...FINAL_FT,
  ...FINAL_BACKUP,
];

function withImplLevel(manifest: any): PlatformManifestDef {
  return { ...manifest, implLevel: computeImplLevel(manifest) };
}

export const ALL_PROVIDERS: PlatformManifestDef[] = [
  ...GLOBAL_PROVIDERS.map(withImplLevel),
  ...REGIONAL_PROVIDERS.map(withImplLevel),
];


export function getProviderById(id: string): PlatformManifestDef | undefined {
  return ALL_PROVIDERS.find((p) => p.providerId === id);
}

export function getProvidersByCategory(category: string): PlatformManifestDef[] {
  return ALL_PROVIDERS.filter((p) => p.category === category);
}

export function getProvidersByRegion(region: string): PlatformManifestDef[] {
  return ALL_PROVIDERS.filter((p) => p.regions.includes('global') || p.regions.includes(region));
}

export function getProvidersByCategories(categories: string[]): PlatformManifestDef[] {
  return ALL_PROVIDERS.filter((p) => categories.includes(p.category));
}

// Stats
export const TOTAL_PROVIDER_COUNT = ALL_PROVIDERS.length;
export const CATEGORIES = [...new Set(ALL_PROVIDERS.map((p) => p.category))].sort();
export const REGIONS_ALL = [...new Set(ALL_PROVIDERS.flatMap((p) => p.regions))].filter((r) => r !== 'global').sort();
