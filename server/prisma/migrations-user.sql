-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "avatar" TEXT,
    "region" TEXT NOT NULL DEFAULT 'CN',
    "language" TEXT NOT NULL DEFAULT 'zh-CN',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "role" TEXT NOT NULL DEFAULT 'USER',
    "subscriptionTier" TEXT NOT NULL DEFAULT 'STANDARD',
    "subscriptionEnd" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "creditBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "frozenCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bonusCreditsUsed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dailyThinkUsed" INTEGER NOT NULL DEFAULT 0,
    "dailyThinkReset" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dailyVideoUsed" INTEGER NOT NULL DEFAULT 0,
    "dailyVideoReset" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dailyResearchUsed" INTEGER NOT NULL DEFAULT 0,
    "dailyResearchReset" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evoSignalsToday" INTEGER NOT NULL DEFAULT 0,
    "evoSignalsReset" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evolutionOptOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "defaultModel" TEXT NOT NULL DEFAULT 'auto',
    "defaultMode" TEXT NOT NULL DEFAULT 'standard',
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "enableVoice" BOOLEAN NOT NULL DEFAULT true,
    "enableSearch" BOOLEAN NOT NULL DEFAULT true,
    "teacherStyle" TEXT NOT NULL DEFAULT 'guided',
    "autoModelPool" TEXT,
    "modeModelPreferences" TEXT,
    "glassBlur" INTEGER NOT NULL DEFAULT 12,
    "glassOpacity" DOUBLE PRECISION NOT NULL DEFAULT 0.06,
    "glassBorderOpacity" DOUBLE PRECISION NOT NULL DEFAULT 0.12,
    "glassRefraction" INTEGER NOT NULL DEFAULT 20,
    "glassSaturate" DOUBLE PRECISION NOT NULL DEFAULT 1.8,
    "glassHighlightOpacity" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "glassEnabled" BOOLEAN NOT NULL DEFAULT true,
    "actionPolicies" TEXT DEFAULT '{}',

    CONSTRAINT "UserSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminInvite" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT,
    "usedBy" TEXT,
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "remaining" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "description" TEXT,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPack" (
    "id" TEXT NOT NULL,
    "credits" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CreditPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "base" TEXT NOT NULL DEFAULT 'USD',
    "target" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "pricingVersionId" TEXT,
    "lockedCredits" INTEGER,
    "lockedPriceUsd" DOUBLE PRECISION,
    "creditGranted" BOOLEAN NOT NULL DEFAULT false,
    "creditGrantedAt" TIMESTAMP(3),
    "creditValidDays" INTEGER,
    "fxVersionId" TEXT,
    "providerPricingVersionId" TEXT,
    "creditPricingVersionId" TEXT,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "expectedAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paymentMethod" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "verifiedTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remainingAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "transactionTime" TIMESTAMP(3) NOT NULL,
    "providerStatus" TEXT,
    "referenceId" TEXT,
    "proofId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProof" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "perceptualHash" TEXT,
    "ocrResult" TEXT,
    "walletType" TEXT,
    "hasObstruction" BOOLEAN NOT NULL DEFAULT false,
    "uploadTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReview" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "proofId" TEXT,
    "decision" TEXT NOT NULL,
    "aiOutput" TEXT,
    "riskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAuditLog" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentQRCode" (
    "id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentQRCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "model" TEXT,
    "duration" INTEGER,
    "tokens" INTEGER,
    "credits" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "credits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'bug',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reply" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestTrace" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "parentMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "environment" TEXT,
    "client" TEXT,
    "appVersion" TEXT,
    "region" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "requestedModel" TEXT,
    "selectedModel" TEXT,
    "provider" TEXT,
    "modelVersion" TEXT,
    "mode" TEXT,
    "routingMode" TEXT,
    "routingPolicy" TEXT,
    "candidateModels" TEXT,
    "selectionReason" TEXT,
    "inputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "outputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "toolInputTokens" INTEGER,
    "toolOutputTokens" INTEGER,
    "totalTokens" INTEGER,
    "providerRawUsage" TEXT,
    "contextTokens" INTEGER,
    "systemPromptTokens" INTEGER,
    "conversationHistoryTokens" INTEGER,
    "retrievalTokens" INTEGER,
    "toolContextTokens" INTEGER,
    "attachmentTokens" INTEGER,
    "userInputTokens" INTEGER,
    "requestStartedAt" TIMESTAMP(3),
    "streamStartedAt" TIMESTAMP(3),
    "firstTokenAt" TIMESTAMP(3),
    "streamCompletedAt" TIMESTAMP(3),
    "finalResponseAt" TIMESTAMP(3),
    "ttftMs" INTEGER,
    "streamDurationMs" INTEGER,
    "streamInterrupted" BOOLEAN NOT NULL DEFAULT false,
    "streamInterruptionReason" TEXT,
    "inputCostUsd" DOUBLE PRECISION,
    "cachedInputCostUsd" DOUBLE PRECISION,
    "outputCostUsd" DOUBLE PRECISION,
    "toolCostUsd" DOUBLE PRECISION,
    "totalApiCostUsd" DOUBLE PRECISION,
    "pricingVersion" TEXT,
    "creditsBefore" DOUBLE PRECISION,
    "creditsReserved" DOUBLE PRECISION,
    "creditsCharged" DOUBLE PRECISION,
    "creditsRefunded" DOUBLE PRECISION,
    "creditsAfter" DOUBLE PRECISION,
    "creditPricingVersion" TEXT,
    "finishReason" TEXT,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "promptVersion" TEXT,
    "routerVersion" TEXT,

    CONSTRAINT "RequestTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "requestId" TEXT,
    "userId" TEXT,
    "eventType" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT,
    "durationMs" INTEGER,
    "payload" TEXT,
    "errorId" TEXT,
    "version" TEXT,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelCall" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "provider" TEXT,
    "requestedModel" TEXT,
    "selectedModel" TEXT,
    "modelVersion" TEXT,
    "mode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "status" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "cachedTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "providerRawUsage" TEXT,
    "inputCostUsd" DOUBLE PRECISION,
    "outputCostUsd" DOUBLE PRECISION,
    "totalCostUsd" DOUBLE PRECISION,
    "finishReason" TEXT,
    "httpStatus" INTEGER,
    "errorMessage" TEXT,

    CONSTRAINT "ModelCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "toolCallId" TEXT,
    "toolName" TEXT,
    "toolVersion" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "status" TEXT,
    "inputSize" INTEGER,
    "outputSize" INTEGER,
    "toolCostUsd" DOUBLE PRECISION,
    "errorCode" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "requestId" TEXT,
    "userId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorType" TEXT,
    "errorCode" TEXT,
    "message" TEXT,
    "stage" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "httpStatus" INTEGER,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "recoverable" BOOLEAN NOT NULL DEFAULT false,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "stack" TEXT,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingTransaction" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "requestId" TEXT,
    "userId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "balanceBefore" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalApiCostUsd" DOUBLE PRECISION,
    "pricingVersion" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "adaptiveProfile" TEXT NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'inferred',
    "status" TEXT NOT NULL DEFAULT 'active',
    "supersedes" TEXT,
    "supersededBy" TEXT,
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRequirement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'active',
    "supersedes" TEXT,
    "supersededBy" TEXT,
    "source" TEXT NOT NULL DEFAULT 'explicit',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserHabit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserHabit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserInterest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "topic" TEXT NOT NULL DEFAULT '*',
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserInterest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'unknown',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "freshness" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "lastAssessedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainSubdomain" (
    "id" TEXT NOT NULL,
    "domainProfileId" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'unknown',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "freshness" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainSubdomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEvidence" (
    "id" TEXT NOT NULL,
    "domainProfileId" TEXT NOT NULL,
    "subdomain" TEXT,
    "evidenceType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "impact" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conversationId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LanguageProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "overallProficiency" TEXT NOT NULL DEFAULT 'unknown',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "freshness" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "preferredExplanationLanguage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastAssessedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LanguageProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LanguageSkill" (
    "id" TEXT NOT NULL,
    "languageProfileId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'unknown',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LanguageSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LanguageVocabulary" (
    "id" TEXT NOT NULL,
    "languageProfileId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'learning',
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LanguageVocabulary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LanguagePreference" (
    "id" TEXT NOT NULL,
    "languageProfileId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'explicit',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LanguagePreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LongTermMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "content" TEXT NOT NULL,
    "structuredData" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "stability" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "freshness" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceVersion" INTEGER,
    "domain" TEXT,
    "conversationId" TEXT,
    "fileId" TEXT,
    "supersedes" TEXT,
    "supersededBy" TEXT,
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LongTermMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryEvent" (
    "id" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "detail" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" INTEGER,
    "hash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileVersion" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "hash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileFact" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "factType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProviderAccount" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "displayName" TEXT,
    "currency" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProviderIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "displayNames" TEXT NOT NULL DEFAULT '[]',
    "normalizedNames" TEXT NOT NULL DEFAULT '[]',
    "phone" TEXT,
    "email" TEXT,
    "accountId" TEXT,
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'verified_payment',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerTransactionId" TEXT,
    "providerReference" TEXT,
    "providerAccountId" TEXT,
    "orderId" TEXT,
    "userId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payerDisplayName" TEXT,
    "payerPhone" TEXT,
    "payerEmail" TEXT,
    "payerAccountId" TEXT,
    "recipientDisplayName" TEXT,
    "recipientAccountId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawProviderData" TEXT,
    "normalizedData" TEXT,
    "attributionStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "verificationStatus" TEXT NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT,
    "sourceType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvidence" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttribution" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "orderId" TEXT,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "matchMethod" TEXT,
    "evidenceSummary" TEXT,
    "reason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentVerification" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountVerified" BOOLEAN NOT NULL DEFAULT false,
    "currencyVerified" BOOLEAN NOT NULL DEFAULT false,
    "recipientVerified" BOOLEAN NOT NULL DEFAULT false,
    "timestampVerified" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyVerified" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "checks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReconciliation" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerTxnId" TEXT NOT NULL,
    "internalPaymentId" TEXT,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detail" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentException" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT,
    "orderId" TEXT,
    "userId" TEXT,
    "exceptionType" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "traceId" TEXT,
    "requestId" TEXT,
    "actualCostUsd" DOUBLE PRECISION,
    "creditsUsed" DOUBLE PRECISION,
    "code" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "protectedCostUsd" DOUBLE PRECISION,
    "protectedCostMyr" DOUBLE PRECISION,
    "pricingVersionId" TEXT,
    "paymentId" TEXT,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "description" TEXT,
    "idempotencyKey" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "creditsReversed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "processedAt" TIMESTAMP(3),
    "processedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpressionProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "adaptationStrength" INTEGER NOT NULL DEFAULT 2,
    "styleTone" TEXT NOT NULL DEFAULT 'neutral',
    "primaryLanguage" TEXT NOT NULL DEFAULT 'zh',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpressionProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpressionPattern" (
    "id" TEXT NOT NULL,
    "expressionProfileId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "meaning" TEXT,
    "contextHint" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'observed',
    "status" TEXT NOT NULL DEFAULT 'learning',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReinforcedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpressionPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmojiSemantic" (
    "id" TEXT NOT NULL,
    "expressionProfileId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "meaning" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL DEFAULT 'neutral',
    "intensity" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "usageCount" INTEGER NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "status" TEXT NOT NULL DEFAULT 'learning',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmojiSemantic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialectOccurrence" (
    "id" TEXT NOT NULL,
    "expressionProfileId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "dialect" TEXT NOT NULL DEFAULT 'unknown',
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "region" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'learning',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DialectOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextPattern" (
    "id" TEXT NOT NULL,
    "expressionProfileId" TEXT NOT NULL,
    "patternId" TEXT,
    "expression" TEXT NOT NULL,
    "scene" TEXT NOT NULL,
    "intent" TEXT,
    "tone" TEXT NOT NULL DEFAULT 'neutral',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'learning',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpressionFeedback" (
    "id" TEXT NOT NULL,
    "expressionProfileId" TEXT NOT NULL,
    "patternId" TEXT,
    "action" TEXT NOT NULL,
    "targetPattern" TEXT,
    "correction" TEXT,
    "note" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpressionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "permissions" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "credentialRef" TEXT,
    "account" TEXT,
    "owner" TEXT,
    "repo" TEXT,
    "accountName" TEXT,
    "platformManifestId" TEXT,
    "sessionId" TEXT,
    "lastHealthCheck" TIMESTAMP(3),
    "lastTokenRefresh" TIMESTAMP(3),
    "meta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "secretCipher" TEXT NOT NULL,
    "meta" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionRequest" (
    "id" TEXT NOT NULL,
    "traceId" TEXT,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT,
    "toolId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "preview" TEXT,
    "requestedBy" TEXT,
    "decidedBy" TEXT,
    "result" TEXT,
    "verificationResult" TEXT,
    "timeoutAt" TIMESTAMP(3),
    "checkpoint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT,
    "status" TEXT NOT NULL,
    "url" TEXT,
    "phase" TEXT NOT NULL,
    "pendingAction" TEXT,
    "result" TEXT,
    "sessionId" TEXT,
    "profile" TEXT,
    "cookiesCount" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskHandoff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromDevice" TEXT,
    "toDevice" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxVersion" (
    "id" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL DEFAULT 'USD',
    "quoteCurrency" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderPricingVersion" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "inputCostPerMUsd" DOUBLE PRECISION NOT NULL,
    "outputCostPerMUsd" DOUBLE PRECISION NOT NULL,
    "cachedCostPerMUsd" DOUBLE PRECISION,
    "protectionFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.15,
    "costFxRate" DOUBLE PRECISION NOT NULL DEFAULT 4.50,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderPricingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPricingVersion" (
    "id" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "packagesJson" TEXT NOT NULL,
    "subscriptionJson" TEXT,
    "modelCreditsPerMJson" TEXT NOT NULL,
    "minSafePricesJson" TEXT NOT NULL,
    "maxSafePricesJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditPricingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingVersion" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "fxVersionId" TEXT,
    "providerPricingVersionId" TEXT,
    "creditPricingVersionId" TEXT,
    "publisher" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL DEFAULT 'active',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformManifest" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategories" TEXT NOT NULL,
    "regions" TEXT NOT NULL,
    "description" TEXT,
    "website" TEXT,
    "apiSupported" BOOLEAN NOT NULL DEFAULT false,
    "oauthSupported" BOOLEAN NOT NULL DEFAULT false,
    "apiKeySupported" BOOLEAN NOT NULL DEFAULT false,
    "mcpSupported" BOOLEAN NOT NULL DEFAULT false,
    "browserSupported" BOOLEAN NOT NULL DEFAULT true,
    "pluginSupported" BOOLEAN NOT NULL DEFAULT false,
    "genericWebSupported" BOOLEAN NOT NULL DEFAULT true,
    "multiAccount" BOOLEAN NOT NULL DEFAULT false,
    "mobileSupported" BOOLEAN NOT NULL DEFAULT true,
    "desktopSupported" BOOLEAN NOT NULL DEFAULT true,
    "webSupported" BOOLEAN NOT NULL DEFAULT true,
    "defaultRiskLevel" TEXT NOT NULL DEFAULT 'R1',
    "rateLimit" TEXT,
    "documentationUrl" TEXT,
    "healthCheckUrl" TEXT,
    "version" TEXT NOT NULL DEFAULT '1',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderHealth" (
    "id" TEXT NOT NULL,
    "platformManifestId" TEXT NOT NULL,
    "connectorType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "availability" DOUBLE PRECISION,
    "latencyMs" INTEGER,
    "errorRate" DOUBLE PRECISION,
    "rateLimitRemaining" INTEGER,
    "quotaUsed" INTEGER,
    "quotaTotal" INTEGER,
    "retryAfter" INTEGER,
    "lastCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorMessage" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorRuntime" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "connectorType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "activeTabCount" INTEGER DEFAULT 0,
    "sessionState" TEXT,
    "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PluginInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "manifestId" TEXT,
    "pluginRegistryId" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "config" TEXT,
    "sandboxPolicy" TEXT,
    "healthStatus" TEXT,
    "lastHealthCheck" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCPInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tools" TEXT,
    "healthStatus" TEXT,
    "lastHealthCheck" TIMESTAMP(3),
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCPInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileBridge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "destinationType" TEXT,
    "destinationId" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "sha256" TEXT,
    "status" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileBridge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "title" TEXT,
    "providerId" TEXT,
    "connectionId" TEXT,
    "taskType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" INTEGER DEFAULT 0,
    "checkpoint" TEXT,
    "result" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "timeoutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelConfig" (
    "modelKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'custom',
    "apiModel" TEXT NOT NULL DEFAULT '',
    "displayName" TEXT NOT NULL DEFAULT '',
    "tier" TEXT NOT NULL DEFAULT 'FREE',
    "maxTokens" INTEGER NOT NULL DEFAULT 8192,
    "contextWindow" INTEGER NOT NULL DEFAULT 32768,
    "costPer1k" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'general',
    "status" TEXT NOT NULL DEFAULT 'online',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "capabilities" TEXT NOT NULL DEFAULT '',
    "supportsReasoning" BOOLEAN NOT NULL DEFAULT false,
    "supportsTools" BOOLEAN NOT NULL DEFAULT false,
    "supportsVision" BOOLEAN NOT NULL DEFAULT false,
    "supportsStreaming" BOOLEAN NOT NULL DEFAULT true,
    "supportsStructuredOutput" BOOLEAN NOT NULL DEFAULT false,
    "qualityProfile" INTEGER NOT NULL DEFAULT 5,
    "speedProfile" INTEGER NOT NULL DEFAULT 5,
    "reliabilityProfile" INTEGER NOT NULL DEFAULT 5,
    "overrideKeys" TEXT NOT NULL DEFAULT '',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelConfig_pkey" PRIMARY KEY ("modelKey")
);

-- CreateTable
CREATE TABLE "SubscriptionPricing" (
    "id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "monthlyUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "yearlyUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "creditGrant" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelCapability" (
    "modelKey" TEXT NOT NULL,
    "supportsTemperature" BOOLEAN NOT NULL DEFAULT true,
    "minTemperature" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxTemperature" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "supportsTopP" BOOLEAN NOT NULL DEFAULT true,
    "minTopP" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxTopP" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "supportsReasoning" BOOLEAN NOT NULL DEFAULT false,
    "supportsFrequencyPenalty" BOOLEAN NOT NULL DEFAULT false,
    "supportsPresencePenalty" BOOLEAN NOT NULL DEFAULT false,
    "supportsStructuredOutput" BOOLEAN NOT NULL DEFAULT false,
    "supportsTools" BOOLEAN NOT NULL DEFAULT false,
    "supportsVision" BOOLEAN NOT NULL DEFAULT false,
    "supportsStreaming" BOOLEAN NOT NULL DEFAULT true,
    "supportsJSONMode" BOOLEAN NOT NULL DEFAULT false,
    "supportsN" BOOLEAN NOT NULL DEFAULT false,
    "supportsLogprobs" BOOLEAN NOT NULL DEFAULT false,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 8192,
    "maxContextTokens" INTEGER NOT NULL DEFAULT 32768,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelCapability_pkey" PRIMARY KEY ("modelKey")
);

-- CreateTable
CREATE TABLE "OrganizationJob" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "objectId" TEXT,
    "triggerReason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "workerId" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "planJson" TEXT,
    "resultJson" TEXT,
    "snapshotRef" TEXT,
    "snapshotHash" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelQuota" (
    "modelKey" TEXT NOT NULL,
    "rpmLimit" INTEGER,
    "tpmLimit" INTEGER,
    "dailyLimit" INTEGER,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 5,
    "requestTimeout" INTEGER NOT NULL DEFAULT 60,
    "tokenBudget" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'default',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelQuota_pkey" PRIMARY KEY ("modelKey")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "userId" TEXT,
    "content" TEXT NOT NULL,
    "title" TEXT,
    "language" TEXT,
    "metadata" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFolder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isRules" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeBase" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "evidenceLevel" TEXT NOT NULL DEFAULT 'C',
    "region" TEXT,
    "product" TEXT,
    "version" TEXT,
    "source" TEXT,
    "folderId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "prompt" TEXT NOT NULL,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalRule" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,

    CONSTRAINT "LegalRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvolutionSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "region" TEXT,
    "signalType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'low',
    "detail" TEXT,
    "attributed" BOOLEAN NOT NULL DEFAULT false,
    "worthEvolving" BOOLEAN NOT NULL DEFAULT false,
    "attribution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvolutionSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvolutionCandidate" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "hypothesis" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "evidenceRefs" TEXT,
    "region" TEXT,
    "userId" TEXT,
    "blastRadius" TEXT NOT NULL DEFAULT 'low',
    "gateLevel" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evaluationId" TEXT,
    "promotedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "canaryPercent" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL DEFAULT 'evolution-engine',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvolutionCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationReport" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "securityPassed" BOOLEAN NOT NULL DEFAULT false,
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "regressionPassed" INTEGER NOT NULL DEFAULT 0,
    "regressionFailed" INTEGER NOT NULL DEFAULT 0,
    "agnesAssessment" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "metrics" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegionInsight" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "insight" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "candidateId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegionInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvolutionAudit" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "candidateId" TEXT,
    "adminId" TEXT,
    "scope" TEXT,
    "reason" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvolutionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvolutionBudget" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "systemPoolTotal" INTEGER NOT NULL DEFAULT 10000,
    "systemPoolUsed" INTEGER NOT NULL DEFAULT 0,
    "signalCount" INTEGER NOT NULL DEFAULT 0,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "promoteCount" INTEGER NOT NULL DEFAULT 0,
    "rejectCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvolutionBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchJob" (
    "rootTaskId" TEXT,
    "iteration" INTEGER,
    "triggerType" TEXT,
    "queries" TEXT,
    "targetFactId" TEXT,
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "variantId" TEXT,
    "jobType" TEXT NOT NULL DEFAULT 'FULL_RESEARCH',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "workerId" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "planJson" TEXT,
    "resultJson" TEXT,
    "queuePosition" INTEGER,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeBlindSpot" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "variantId" TEXT,
    "gapType" TEXT NOT NULL,
    "gapDescription" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "researchJobId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBlindSpot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchQueueState" (
    "id" TEXT NOT NULL,
    "queueName" TEXT NOT NULL,
    "maxConcurren" INTEGER NOT NULL DEFAULT 5,
    "activeCount" INTEGER NOT NULL DEFAULT 0,
    "lastDequeue" TIMESTAMP(3),
    "configJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchQueueState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvolutionJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "region" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "workerId" TEXT,
    "lastError" TEXT,
    "resultJson" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvolutionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelLimit" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "version" TEXT,
    "inputTokenLimit" INTEGER,
    "outputTokenLimit" INTEGER,
    "contextWindow" INTEGER,
    "source" TEXT,
    "sourceUrl" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelLimitHistory" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "version" TEXT,
    "outputTokenLimit" INTEGER,
    "source" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelLimitHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredModel" (
    "apiModel" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "inputPrice" DOUBLE PRECISION NOT NULL,
    "cacheHitPrice" DOUBLE PRECISION NOT NULL,
    "cacheMissPrice" DOUBLE PRECISION NOT NULL,
    "outputPrice" DOUBLE PRECISION NOT NULL,
    "totalCost" DOUBLE PRECISION NOT NULL,
    "creditsPer1M" DOUBLE PRECISION NOT NULL,
    "originalCost" DOUBLE PRECISION NOT NULL,
    "currentCost" DOUBLE PRECISION NOT NULL,
    "priceChanged" BOOLEAN NOT NULL DEFAULT false,
    "priceChangedAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priceVerifiedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "sourceUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredModel_pkey" PRIMARY KEY ("apiModel")
);

-- CreateTable
CREATE TABLE "ModelPriceHistory" (
    "id" TEXT NOT NULL,
    "apiModel" TEXT NOT NULL,
    "inputPrice" DOUBLE PRECISION NOT NULL,
    "cacheHitPrice" DOUBLE PRECISION NOT NULL,
    "cacheMissPrice" DOUBLE PRECISION NOT NULL,
    "outputPrice" DOUBLE PRECISION NOT NULL,
    "totalCost" DOUBLE PRECISION NOT NULL,
    "creditsPer1M" DOUBLE PRECISION NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "factId" TEXT NOT NULL,
    "refreshCycle" TEXT NOT NULL,
    "objectId" TEXT,
    "objectType" TEXT,
    "reason" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "workerId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "prevIntervalMonths" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefreshTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfRepairTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "targetFactId" TEXT,
    "rootJobId" TEXT,
    "rootTaskId" TEXT,
    "researchJobId" TEXT,
    "triggerType" TEXT,
    "reason" TEXT,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "lastStatus" TEXT,
    "lifecycleStatus" TEXT,
    "verificationStatus" TEXT,
    "refreshCycle" TEXT,
    "resultJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "terminateReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfRepairTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillAnalysisJob" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "workerId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "resultJson" TEXT,
    "trigger" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillAnalysisJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "correctionEventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queriesJson" TEXT,
    "resultJson" TEXT,
    "lastError" TEXT,
    "workerId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "VerificationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextCompressionJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inputMemoryIds" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "resultMemoryId" TEXT,
    "lastError" TEXT,
    "compressionVersion" INTEGER NOT NULL DEFAULT 1,
    "workerId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextCompressionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "supersededBy" TEXT,
    "supersededAt" TIMESTAMP(3),
    "conversationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "dedupeKey" TEXT,
    "eventKind" TEXT,
    "provenanceMessageId" TEXT,
    "scenarioId" TEXT,
    "entities" TEXT,
    "references" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectionEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "messageFromId" TEXT NOT NULL,
    "assistantClaimId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetsPreviousAiOutput" BOOLEAN NOT NULL DEFAULT false,
    "verificationRequired" BOOLEAN NOT NULL DEFAULT false,
    "claimSummary" TEXT,
    "userClaim" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAgainst" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorrectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActiveTaskState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "task" TEXT,
    "stage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "currentGoal" TEXT,
    "constraints" TEXT,
    "payloadJson" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActiveTaskState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelProfileJob" (
    "id" TEXT NOT NULL,
    "modelId" TEXT,
    "provider" TEXT,
    "jobKind" TEXT NOT NULL DEFAULT 'model_profile',
    "scenarioId" TEXT,
    "poolVersion" TEXT,
    "resultJson" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "trigger" TEXT,
    "queuePosition" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "workerId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "ModelProfileJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioArtifact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'audio',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "originalStorageRef" TEXT NOT NULL,
    "playbackStorageRef" TEXT,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "duration" DOUBLE PRECISION,
    "generationId" TEXT,
    "selectedModel" TEXT,
    "actualModel" TEXT,
    "voiceId" TEXT,
    "voiceDesignPrompt" TEXT,
    "encoding" TEXT,
    "sampleRate" INTEGER,
    "channels" INTEGER,
    "bitDepth" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "providerRequestId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceReference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "artifactId" TEXT,
    "mimeType" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeArtifact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'office',
    "format" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "originalStorageRef" TEXT NOT NULL,
    "previewStorageRef" TEXT,
    "previewStatus" TEXT NOT NULL DEFAULT 'pending',
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "generationId" TEXT,
    "selectedModel" TEXT,
    "actualModel" TEXT,
    "specJson" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parentVersion" INTEGER,
    "supersededBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "checksum" TEXT,
    "pageCount" INTEGER,
    "providerRequestId" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficeArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "sessionId" TEXT,
    "messageId" TEXT,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'standard',
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "overflowTransferred" BOOLEAN NOT NULL DEFAULT false,
    "overflowAmount" INTEGER NOT NULL DEFAULT 0,
    "actualInputTokens" INTEGER NOT NULL DEFAULT 0,
    "actualOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "actualTotalTokens" INTEGER NOT NULL DEFAULT 0,
    "displayInputTokens" INTEGER NOT NULL DEFAULT 0,
    "displayOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "displayTotalTokens" INTEGER NOT NULL DEFAULT 0,
    "modelVersion" TEXT,
    "verifiedOutputLimit" INTEGER,
    "limitSource" TEXT,
    "limitVerifiedAt" TIMESTAMP(3),
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheHitTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheMissTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "creditsSpent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "UserSetting_userId_key" ON "UserSetting"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminInvite_token_key" ON "AdminInvite"("token");

-- CreateIndex
CREATE INDEX "CreditBatch_userId_isActive_expiryDate_idx" ON "CreditBatch"("userId", "isActive", "expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_base_target_key" ON "ExchangeRate"("base", "target");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOrder_orderId_key" ON "PaymentOrder"("orderId");

-- CreateIndex
CREATE INDEX "PaymentOrder_userId_status_idx" ON "PaymentOrder"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_transactionId_key" ON "PaymentTransaction"("transactionId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_orderId_idx" ON "PaymentTransaction"("orderId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_transactionId_idx" ON "PaymentTransaction"("transactionId");

-- CreateIndex
CREATE INDEX "PaymentProof_orderId_idx" ON "PaymentProof"("orderId");

-- CreateIndex
CREATE INDEX "PaymentProof_fileHash_idx" ON "PaymentProof"("fileHash");

-- CreateIndex
CREATE INDEX "PaymentReview_orderId_idx" ON "PaymentReview"("orderId");

-- CreateIndex
CREATE INDEX "PaymentAuditLog_orderId_createdAt_idx" ON "PaymentAuditLog"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentQRCode_method_key" ON "PaymentQRCode"("method");

-- CreateIndex
CREATE UNIQUE INDEX "RequestTrace_requestId_key" ON "RequestTrace"("requestId");

-- CreateIndex
CREATE INDEX "RequestTrace_userId_createdAt_idx" ON "RequestTrace"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RequestTrace_status_idx" ON "RequestTrace"("status");

-- CreateIndex
CREATE INDEX "RequestTrace_createdAt_idx" ON "RequestTrace"("createdAt");

-- CreateIndex
CREATE INDEX "RequestTrace_selectedModel_idx" ON "RequestTrace"("selectedModel");

-- CreateIndex
CREATE INDEX "RequestTrace_conversationId_idx" ON "RequestTrace"("conversationId");

-- CreateIndex
CREATE INDEX "Event_traceId_eventType_idx" ON "Event"("traceId", "eventType");

-- CreateIndex
CREATE INDEX "Event_timestamp_idx" ON "Event"("timestamp");

-- CreateIndex
CREATE INDEX "Event_eventType_timestamp_idx" ON "Event"("eventType", "timestamp");

-- CreateIndex
CREATE INDEX "ModelCall_traceId_idx" ON "ModelCall"("traceId");

-- CreateIndex
CREATE INDEX "ModelCall_selectedModel_status_idx" ON "ModelCall"("selectedModel", "status");

-- CreateIndex
CREATE INDEX "ToolCall_traceId_idx" ON "ToolCall"("traceId");

-- CreateIndex
CREATE INDEX "ToolCall_toolName_idx" ON "ToolCall"("toolName");

-- CreateIndex
CREATE INDEX "ErrorLog_traceId_idx" ON "ErrorLog"("traceId");

-- CreateIndex
CREATE INDEX "ErrorLog_errorType_idx" ON "ErrorLog"("errorType");

-- CreateIndex
CREATE INDEX "ErrorLog_stage_idx" ON "ErrorLog"("stage");

-- CreateIndex
CREATE INDEX "ErrorLog_timestamp_idx" ON "ErrorLog"("timestamp");

-- CreateIndex
CREATE INDEX "ErrorLog_severity_idx" ON "ErrorLog"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "BillingTransaction_idempotencyKey_key" ON "BillingTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingTransaction_traceId_idx" ON "BillingTransaction"("traceId");

-- CreateIndex
CREATE INDEX "BillingTransaction_userId_createdAt_idx" ON "BillingTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingTransaction_createdAt_idx" ON "BillingTransaction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE INDEX "UserPreference_userId_status_category_idx" ON "UserPreference"("userId", "status", "category");

-- CreateIndex
CREATE INDEX "UserPreference_userId_type_idx" ON "UserPreference"("userId", "type");

-- CreateIndex
CREATE INDEX "UserRequirement_userId_status_idx" ON "UserRequirement"("userId", "status");

-- CreateIndex
CREATE INDEX "UserHabit_userId_status_idx" ON "UserHabit"("userId", "status");

-- CreateIndex
CREATE INDEX "UserHabit_userId_type_idx" ON "UserHabit"("userId", "type");

-- CreateIndex
CREATE INDEX "UserInterest_userId_status_idx" ON "UserInterest"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UserInterest_userId_domain_topic_key" ON "UserInterest"("userId", "domain", "topic");

-- CreateIndex
CREATE INDEX "DomainProfile_userId_idx" ON "DomainProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DomainProfile_userId_domain_key" ON "DomainProfile"("userId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "DomainSubdomain_domainProfileId_subdomain_key" ON "DomainSubdomain"("domainProfileId", "subdomain");

-- CreateIndex
CREATE INDEX "DomainEvidence_domainProfileId_idx" ON "DomainEvidence"("domainProfileId");

-- CreateIndex
CREATE INDEX "LanguageProfile_userId_idx" ON "LanguageProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LanguageProfile_userId_language_key" ON "LanguageProfile"("userId", "language");

-- CreateIndex
CREATE UNIQUE INDEX "LanguageSkill_languageProfileId_dimension_key" ON "LanguageSkill"("languageProfileId", "dimension");

-- CreateIndex
CREATE INDEX "LanguageVocabulary_languageProfileId_status_idx" ON "LanguageVocabulary"("languageProfileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LanguageVocabulary_languageProfileId_term_key" ON "LanguageVocabulary"("languageProfileId", "term");

-- CreateIndex
CREATE INDEX "LanguagePreference_languageProfileId_status_idx" ON "LanguagePreference"("languageProfileId", "status");

-- CreateIndex
CREATE INDEX "LongTermMemory_userId_type_status_idx" ON "LongTermMemory"("userId", "type", "status");

-- CreateIndex
CREATE INDEX "LongTermMemory_userId_domain_status_idx" ON "LongTermMemory"("userId", "domain", "status");

-- CreateIndex
CREATE INDEX "LongTermMemory_userId_conversationId_idx" ON "LongTermMemory"("userId", "conversationId");

-- CreateIndex
CREATE INDEX "LongTermMemory_userId_fileId_idx" ON "LongTermMemory"("userId", "fileId");

-- CreateIndex
CREATE INDEX "LongTermMemory_userId_freshness_idx" ON "LongTermMemory"("userId", "freshness");

-- CreateIndex
CREATE INDEX "LongTermMemory_userId_importance_status_idx" ON "LongTermMemory"("userId", "importance", "status");

-- CreateIndex
CREATE INDEX "MemoryEvent_memoryId_idx" ON "MemoryEvent"("memoryId");

-- CreateIndex
CREATE INDEX "MemoryEvent_eventType_createdAt_idx" ON "MemoryEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "FileRecord_userId_status_idx" ON "FileRecord"("userId", "status");

-- CreateIndex
CREATE INDEX "FileRecord_hash_idx" ON "FileRecord"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "FileVersion_fileId_version_key" ON "FileVersion"("fileId", "version");

-- CreateIndex
CREATE INDEX "FileFact_fileId_status_idx" ON "FileFact"("fileId", "status");

-- CreateIndex
CREATE INDEX "FileFact_fileId_version_idx" ON "FileFact"("fileId", "version");

-- CreateIndex
CREATE INDEX "PaymentProviderAccount_provider_isActive_idx" ON "PaymentProviderAccount"("provider", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderAccount_provider_accountId_key" ON "PaymentProviderAccount"("provider", "accountId");

-- CreateIndex
CREATE INDEX "PaymentProviderIdentity_userId_idx" ON "PaymentProviderIdentity"("userId");

-- CreateIndex
CREATE INDEX "PaymentProviderIdentity_provider_idx" ON "PaymentProviderIdentity"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderIdentity_userId_provider_key" ON "PaymentProviderIdentity"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_provider_providerTransactionId_idx" ON "Payment"("provider", "providerTransactionId");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_userId_idx" ON "Payment"("userId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_attributionStatus_idx" ON "Payment"("attributionStatus");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- CreateIndex
CREATE INDEX "PaymentEvidence_paymentId_idx" ON "PaymentEvidence"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentEvidence_type_idx" ON "PaymentEvidence"("type");

-- CreateIndex
CREATE INDEX "PaymentAttribution_paymentId_idx" ON "PaymentAttribution"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentAttribution_orderId_idx" ON "PaymentAttribution"("orderId");

-- CreateIndex
CREATE INDEX "PaymentAttribution_status_idx" ON "PaymentAttribution"("status");

-- CreateIndex
CREATE INDEX "PaymentVerification_paymentId_idx" ON "PaymentVerification"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentVerification_status_idx" ON "PaymentVerification"("status");

-- CreateIndex
CREATE INDEX "PaymentReconciliation_provider_createdAt_idx" ON "PaymentReconciliation"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentReconciliation_type_status_idx" ON "PaymentReconciliation"("type", "status");

-- CreateIndex
CREATE INDEX "PaymentException_exceptionType_status_idx" ON "PaymentException"("exceptionType", "status");

-- CreateIndex
CREATE INDEX "PaymentException_status_createdAt_idx" ON "PaymentException"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentException_paymentId_idx" ON "PaymentException"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_paymentId_idx" ON "CreditLedger"("paymentId");

-- CreateIndex
CREATE INDEX "CreditLedger_type_idx" ON "CreditLedger"("type");

-- CreateIndex
CREATE INDEX "CreditLedger_idempotencyKey_idx" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_paymentId_key" ON "Refund"("paymentId");

-- CreateIndex
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");

-- CreateIndex
CREATE INDEX "Refund_userId_idx" ON "Refund"("userId");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ExpressionProfile_userId_key" ON "ExpressionProfile"("userId");

-- CreateIndex
CREATE INDEX "ExpressionProfile_userId_idx" ON "ExpressionProfile"("userId");

-- CreateIndex
CREATE INDEX "ExpressionPattern_expressionProfileId_status_idx" ON "ExpressionPattern"("expressionProfileId", "status");

-- CreateIndex
CREATE INDEX "ExpressionPattern_expressionProfileId_dimension_idx" ON "ExpressionPattern"("expressionProfileId", "dimension");

-- CreateIndex
CREATE UNIQUE INDEX "ExpressionPattern_expressionProfileId_dimension_pattern_key" ON "ExpressionPattern"("expressionProfileId", "dimension", "pattern");

-- CreateIndex
CREATE INDEX "EmojiSemantic_expressionProfileId_status_idx" ON "EmojiSemantic"("expressionProfileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmojiSemantic_expressionProfileId_emoji_key" ON "EmojiSemantic"("expressionProfileId", "emoji");

-- CreateIndex
CREATE INDEX "DialectOccurrence_expressionProfileId_status_idx" ON "DialectOccurrence"("expressionProfileId", "status");

-- CreateIndex
CREATE INDEX "DialectOccurrence_dialect_idx" ON "DialectOccurrence"("dialect");

-- CreateIndex
CREATE UNIQUE INDEX "DialectOccurrence_expressionProfileId_term_key" ON "DialectOccurrence"("expressionProfileId", "term");

-- CreateIndex
CREATE INDEX "ContextPattern_expressionProfileId_scene_idx" ON "ContextPattern"("expressionProfileId", "scene");

-- CreateIndex
CREATE INDEX "ContextPattern_expressionProfileId_status_idx" ON "ContextPattern"("expressionProfileId", "status");

-- CreateIndex
CREATE INDEX "ExpressionFeedback_expressionProfileId_createdAt_idx" ON "ExpressionFeedback"("expressionProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "Connection_userId_providerId_idx" ON "Connection"("userId", "providerId");

-- CreateIndex
CREATE INDEX "Connection_status_idx" ON "Connection"("status");

-- CreateIndex
CREATE INDEX "Connection_platformManifestId_idx" ON "Connection"("platformManifestId");

-- CreateIndex
CREATE INDEX "Credential_userId_idx" ON "Credential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_userId_providerId_type_key" ON "Credential"("userId", "providerId", "type");

-- CreateIndex
CREATE INDEX "ActionRequest_userId_status_idx" ON "ActionRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "ActionRequest_traceId_idx" ON "ActionRequest"("traceId");

-- CreateIndex
CREATE INDEX "ActionRequest_connectionId_idx" ON "ActionRequest"("connectionId");

-- CreateIndex
CREATE INDEX "DeviceSession_userId_status_idx" ON "DeviceSession"("userId", "status");

-- CreateIndex
CREATE INDEX "BrowserSession_userId_status_idx" ON "BrowserSession"("userId", "status");

-- CreateIndex
CREATE INDEX "BrowserSession_providerId_idx" ON "BrowserSession"("providerId");

-- CreateIndex
CREATE INDEX "TaskHandoff_userId_status_idx" ON "TaskHandoff"("userId", "status");

-- CreateIndex
CREATE INDEX "TaskHandoff_conversationId_idx" ON "TaskHandoff"("conversationId");

-- CreateIndex
CREATE INDEX "FxVersion_baseCurrency_quoteCurrency_isActive_idx" ON "FxVersion"("baseCurrency", "quoteCurrency", "isActive");

-- CreateIndex
CREATE INDEX "FxVersion_fetchedAt_idx" ON "FxVersion"("fetchedAt");

-- CreateIndex
CREATE INDEX "ProviderPricingVersion_provider_effectiveAt_idx" ON "ProviderPricingVersion"("provider", "effectiveAt");

-- CreateIndex
CREATE INDEX "CreditPricingVersion_status_effectiveAt_idx" ON "CreditPricingVersion"("status", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "PricingVersion_code_key" ON "PricingVersion"("code");

-- CreateIndex
CREATE INDEX "PricingVersion_status_publishedAt_idx" ON "PricingVersion"("status", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformManifest_providerId_key" ON "PlatformManifest"("providerId");

-- CreateIndex
CREATE INDEX "PlatformManifest_category_idx" ON "PlatformManifest"("category");

-- CreateIndex
CREATE INDEX "PlatformManifest_regions_idx" ON "PlatformManifest"("regions");

-- CreateIndex
CREATE INDEX "PlatformManifest_isActive_idx" ON "PlatformManifest"("isActive");

-- CreateIndex
CREATE INDEX "ProviderHealth_platformManifestId_checkedAt_idx" ON "ProviderHealth"("platformManifestId", "checkedAt");

-- CreateIndex
CREATE INDEX "ProviderHealth_status_idx" ON "ProviderHealth"("status");

-- CreateIndex
CREATE INDEX "ConnectorRuntime_connectionId_idx" ON "ConnectorRuntime"("connectionId");

-- CreateIndex
CREATE INDEX "ConnectorRuntime_status_idx" ON "ConnectorRuntime"("status");

-- CreateIndex
CREATE INDEX "PluginInstance_userId_status_idx" ON "PluginInstance"("userId", "status");

-- CreateIndex
CREATE INDEX "MCPInstance_userId_status_idx" ON "MCPInstance"("userId", "status");

-- CreateIndex
CREATE INDEX "FileBridge_userId_sourceType_idx" ON "FileBridge"("userId", "sourceType");

-- CreateIndex
CREATE INDEX "FileBridge_userId_status_idx" ON "FileBridge"("userId", "status");

-- CreateIndex
CREATE INDEX "TaskRun_userId_status_idx" ON "TaskRun"("userId", "status");

-- CreateIndex
CREATE INDEX "TaskRun_userId_createdAt_idx" ON "TaskRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskRun_conversationId_idx" ON "TaskRun"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPricing_tier_key" ON "SubscriptionPricing"("tier");

-- CreateIndex
CREATE INDEX "ModelCapability_modelKey_idx" ON "ModelCapability"("modelKey");

-- CreateIndex
CREATE INDEX "OrganizationJob_scopeType_scopeId_status_idx" ON "OrganizationJob"("scopeType", "scopeId", "status");

-- CreateIndex
CREATE INDEX "OrganizationJob_status_priority_idx" ON "OrganizationJob"("status", "priority");

-- CreateIndex
CREATE INDEX "OrganizationJob_workerId_heartbeatAt_idx" ON "OrganizationJob"("workerId", "heartbeatAt");

-- CreateIndex
CREATE INDEX "OrganizationJob_leaseUntil_idx" ON "OrganizationJob"("leaseUntil");

-- CreateIndex
CREATE INDEX "DocumentChunk_sourceType_sourceId_idx" ON "DocumentChunk"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "DocumentChunk_userId_idx" ON "DocumentChunk"("userId");

-- CreateIndex
CREATE INDEX "DocumentChunk_isActive_idx" ON "DocumentChunk"("isActive");

-- CreateIndex
CREATE INDEX "EvolutionSignal_signalType_createdAt_idx" ON "EvolutionSignal"("signalType", "createdAt");

-- CreateIndex
CREATE INDEX "EvolutionSignal_userId_idx" ON "EvolutionSignal"("userId");

-- CreateIndex
CREATE INDEX "EvolutionSignal_region_idx" ON "EvolutionSignal"("region");

-- CreateIndex
CREATE INDEX "EvolutionCandidate_scope_status_idx" ON "EvolutionCandidate"("scope", "status");

-- CreateIndex
CREATE INDEX "EvolutionCandidate_gateLevel_status_idx" ON "EvolutionCandidate"("gateLevel", "status");

-- CreateIndex
CREATE INDEX "EvolutionCandidate_region_idx" ON "EvolutionCandidate"("region");

-- CreateIndex
CREATE INDEX "EvolutionCandidate_status_createdAt_idx" ON "EvolutionCandidate"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EvaluationReport_candidateId_idx" ON "EvaluationReport"("candidateId");

-- CreateIndex
CREATE INDEX "RegionInsight_region_isActive_idx" ON "RegionInsight"("region", "isActive");

-- CreateIndex
CREATE INDEX "EvolutionAudit_action_createdAt_idx" ON "EvolutionAudit"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvolutionBudget_date_key" ON "EvolutionBudget"("date");

-- CreateIndex
CREATE INDEX "ResearchJob_status_queuedAt_idx" ON "ResearchJob"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "ResearchJob_objectId_status_idx" ON "ResearchJob"("objectId", "status");

-- CreateIndex
CREATE INDEX "ResearchJob_workerId_heartbeatAt_idx" ON "ResearchJob"("workerId", "heartbeatAt");

-- CreateIndex
CREATE INDEX "ResearchJob_leaseUntil_idx" ON "ResearchJob"("leaseUntil");

-- CreateIndex
CREATE INDEX "KnowledgeBlindSpot_objectId_status_idx" ON "KnowledgeBlindSpot"("objectId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeBlindSpot_gapType_status_idx" ON "KnowledgeBlindSpot"("gapType", "status");

-- CreateIndex
CREATE INDEX "KnowledgeBlindSpot_researchJobId_idx" ON "KnowledgeBlindSpot"("researchJobId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchQueueState_queueName_key" ON "ResearchQueueState"("queueName");

-- CreateIndex
CREATE INDEX "EvolutionJob_status_queuedAt_idx" ON "EvolutionJob"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "EvolutionJob_userId_conversationId_status_idx" ON "EvolutionJob"("userId", "conversationId", "status");

-- CreateIndex
CREATE INDEX "EvolutionJob_workerId_heartbeatAt_idx" ON "EvolutionJob"("workerId", "heartbeatAt");

-- CreateIndex
CREATE INDEX "EvolutionJob_leaseUntil_idx" ON "EvolutionJob"("leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ModelLimit_modelId_key" ON "ModelLimit"("modelId");

-- CreateIndex
CREATE INDEX "ModelLimit_modelId_idx" ON "ModelLimit"("modelId");

-- CreateIndex
CREATE INDEX "ModelLimitHistory_modelId_recordedAt_idx" ON "ModelLimitHistory"("modelId", "recordedAt");

-- CreateIndex
CREATE INDEX "DiscoveredModel_status_idx" ON "DiscoveredModel"("status");

-- CreateIndex
CREATE INDEX "DiscoveredModel_provider_idx" ON "DiscoveredModel"("provider");

-- CreateIndex
CREATE INDEX "ModelPriceHistory_apiModel_changedAt_idx" ON "ModelPriceHistory"("apiModel", "changedAt");

-- CreateIndex
CREATE INDEX "RefreshTask_status_priority_idx" ON "RefreshTask"("status", "priority");

-- CreateIndex
CREATE INDEX "RefreshTask_userId_objectType_idx" ON "RefreshTask"("userId", "objectType");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshTask_factId_refreshCycle_key" ON "RefreshTask"("factId", "refreshCycle");

-- CreateIndex
CREATE INDEX "SelfRepairTask_userId_status_idx" ON "SelfRepairTask"("userId", "status");

-- CreateIndex
CREATE INDEX "SkillAnalysisJob_status_idx" ON "SkillAnalysisJob"("status");

-- CreateIndex
CREATE INDEX "SkillAnalysisJob_skillId_idx" ON "SkillAnalysisJob"("skillId");

-- CreateIndex
CREATE INDEX "VerificationJob_userId_conversationId_idx" ON "VerificationJob"("userId", "conversationId");

-- CreateIndex
CREATE INDEX "VerificationJob_status_idx" ON "VerificationJob"("status");

-- CreateIndex
CREATE INDEX "ContextCompressionJob_status_idx" ON "ContextCompressionJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ContextCompressionJob_userId_conversationId_dedupeKey_key" ON "ContextCompressionJob"("userId", "conversationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "ContextMemory_userId_conversationId_type_idx" ON "ContextMemory"("userId", "conversationId", "type");

-- CreateIndex
CREATE INDEX "ContextMemory_userId_eventKind_idx" ON "ContextMemory"("userId", "eventKind");

-- CreateIndex
CREATE UNIQUE INDEX "ContextMemory_userId_conversationId_dedupeKey_key" ON "ContextMemory"("userId", "conversationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "CorrectionEvent_userId_verificationRequired_idx" ON "CorrectionEvent"("userId", "verificationRequired");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionEvent_userId_conversationId_dedupeKey_key" ON "CorrectionEvent"("userId", "conversationId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ActiveTaskState_userId_conversationId_key" ON "ActiveTaskState"("userId", "conversationId");

-- CreateIndex
CREATE INDEX "ModelProfileJob_status_idx" ON "ModelProfileJob"("status");

-- CreateIndex
CREATE INDEX "ModelProfileJob_provider_idx" ON "ModelProfileJob"("provider");

-- CreateIndex
CREATE INDEX "AudioArtifact_userId_status_idx" ON "AudioArtifact"("userId", "status");

-- CreateIndex
CREATE INDEX "AudioArtifact_conversationId_messageId_idx" ON "AudioArtifact"("conversationId", "messageId");

-- CreateIndex
CREATE INDEX "AudioArtifact_userId_model_status_idx" ON "AudioArtifact"("userId", "model", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AudioArtifact_userId_dedupeKey_key" ON "AudioArtifact"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "VoiceReference_userId_idx" ON "VoiceReference"("userId");

-- CreateIndex
CREATE INDEX "OfficeArtifact_userId_status_idx" ON "OfficeArtifact"("userId", "status");

-- CreateIndex
CREATE INDEX "OfficeArtifact_userId_type_format_idx" ON "OfficeArtifact"("userId", "type", "format");

-- CreateIndex
CREATE INDEX "OfficeArtifact_conversationId_messageId_idx" ON "OfficeArtifact"("conversationId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "OfficeArtifact_userId_dedupeKey_key" ON "OfficeArtifact"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "TokenUsage_userId_createdAt_idx" ON "TokenUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenUsage_model_createdAt_idx" ON "TokenUsage"("model", "createdAt");

-- CreateIndex
CREATE INDEX "TokenUsage_conversationId_idx" ON "TokenUsage"("conversationId");

-- AddForeignKey
ALTER TABLE "UserSetting" ADD CONSTRAINT "UserSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryEntry" ADD CONSTRAINT "MemoryEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditBatch" ADD CONSTRAINT "CreditBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PaymentOrder"("orderId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProof" ADD CONSTRAINT "PaymentProof_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PaymentOrder"("orderId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReview" ADD CONSTRAINT "PaymentReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PaymentOrder"("orderId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAuditLog" ADD CONSTRAINT "PaymentAuditLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PaymentOrder"("orderId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LogEntry" ADD CONSTRAINT "LogEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelUsage" ADD CONSTRAINT "ModelUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "RequestTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelCall" ADD CONSTRAINT "ModelCall_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "RequestTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "RequestTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorLog" ADD CONSTRAINT "ErrorLog_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "RequestTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingTransaction" ADD CONSTRAINT "BillingTransaction_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "RequestTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRequirement" ADD CONSTRAINT "UserRequirement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserHabit" ADD CONSTRAINT "UserHabit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInterest" ADD CONSTRAINT "UserInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainProfile" ADD CONSTRAINT "DomainProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainSubdomain" ADD CONSTRAINT "DomainSubdomain_domainProfileId_fkey" FOREIGN KEY ("domainProfileId") REFERENCES "DomainProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEvidence" ADD CONSTRAINT "DomainEvidence_domainProfileId_fkey" FOREIGN KEY ("domainProfileId") REFERENCES "DomainProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LanguageProfile" ADD CONSTRAINT "LanguageProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LanguageSkill" ADD CONSTRAINT "LanguageSkill_languageProfileId_fkey" FOREIGN KEY ("languageProfileId") REFERENCES "LanguageProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LanguageVocabulary" ADD CONSTRAINT "LanguageVocabulary_languageProfileId_fkey" FOREIGN KEY ("languageProfileId") REFERENCES "LanguageProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LanguagePreference" ADD CONSTRAINT "LanguagePreference_languageProfileId_fkey" FOREIGN KEY ("languageProfileId") REFERENCES "LanguageProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LongTermMemory" ADD CONSTRAINT "LongTermMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryEvent" ADD CONSTRAINT "MemoryEvent_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "LongTermMemory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileRecord" ADD CONSTRAINT "FileRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileFact" ADD CONSTRAINT "FileFact_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProviderIdentity" ADD CONSTRAINT "PaymentProviderIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PaymentOrder"("orderId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvidence" ADD CONSTRAINT "PaymentEvidence_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttribution" ADD CONSTRAINT "PaymentAttribution_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttribution" ADD CONSTRAINT "PaymentAttribution_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PaymentOrder"("orderId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentVerification" ADD CONSTRAINT "PaymentVerification_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpressionProfile" ADD CONSTRAINT "ExpressionProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpressionPattern" ADD CONSTRAINT "ExpressionPattern_expressionProfileId_fkey" FOREIGN KEY ("expressionProfileId") REFERENCES "ExpressionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmojiSemantic" ADD CONSTRAINT "EmojiSemantic_expressionProfileId_fkey" FOREIGN KEY ("expressionProfileId") REFERENCES "ExpressionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DialectOccurrence" ADD CONSTRAINT "DialectOccurrence_expressionProfileId_fkey" FOREIGN KEY ("expressionProfileId") REFERENCES "ExpressionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextPattern" ADD CONSTRAINT "ContextPattern_expressionProfileId_fkey" FOREIGN KEY ("expressionProfileId") REFERENCES "ExpressionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpressionFeedback" ADD CONSTRAINT "ExpressionFeedback_expressionProfileId_fkey" FOREIGN KEY ("expressionProfileId") REFERENCES "ExpressionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingVersion" ADD CONSTRAINT "PricingVersion_fxVersionId_fkey" FOREIGN KEY ("fxVersionId") REFERENCES "FxVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingVersion" ADD CONSTRAINT "PricingVersion_providerPricingVersionId_fkey" FOREIGN KEY ("providerPricingVersionId") REFERENCES "ProviderPricingVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingVersion" ADD CONSTRAINT "PricingVersion_creditPricingVersionId_fkey" FOREIGN KEY ("creditPricingVersionId") REFERENCES "CreditPricingVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderHealth" ADD CONSTRAINT "ProviderHealth_platformManifestId_fkey" FOREIGN KEY ("platformManifestId") REFERENCES "PlatformManifest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "KnowledgeFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable (provider connections: admin-managed Base URLs + API key pools)
CREATE TABLE IF NOT EXISTS "ProviderConnection" (
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT NOT NULL,
    "baseUrlRoot" TEXT,
    "apiKeys" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("provider")
);

-- User profile: optional gender field (2026-10-12)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "gender" TEXT;

-- ============================================================
-- CurationJob — 用户信息整理 AI 的执行追踪（2026-10-14）
-- 幂等由 dedupeKey 唯一约束保证；状态机 analyzed → saved/noop/review/partial，
-- 伪取 failed。
-- ============================================================
CREATE TABLE IF NOT EXISTS "CurationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'analyzed',
    "trigger" TEXT NOT NULL DEFAULT 'auto',
    "opsJson" TEXT NOT NULL DEFAULT '[]',
    "appliedJson" TEXT NOT NULL DEFAULT '[]',
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CurationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CurationJob_dedupeKey_key" ON "CurationJob"("dedupeKey");
CREATE INDEX IF NOT EXISTS "CurationJob_userId_createdAt_idx" ON "CurationJob"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "CurationJob_status_idx" ON "CurationJob"("status");

-- 清理外键：用户被删时同步删除其 CurationJob
ALTER TABLE "CurationJob" ADD CONSTRAINT "CurationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

