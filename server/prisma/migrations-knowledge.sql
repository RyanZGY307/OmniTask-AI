-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "KnowledgeFolder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
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
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "prompt" TEXT NOT NULL,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "constraints" TEXT NOT NULL DEFAULT '[]',
    "applicable_domains" TEXT NOT NULL DEFAULT '[]',
    "applicable_task_types" TEXT NOT NULL DEFAULT '[]',
    "scenario_features" TEXT NOT NULL DEFAULT '[]',
    "negative_applicability" TEXT NOT NULL DEFAULT '[]',
    "required_conditions" TEXT NOT NULL DEFAULT '[]',
    "optional_conditions" TEXT NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "analysisStatus" TEXT NOT NULL DEFAULT 'pending',
    "lastAnalyzedAt" TIMESTAMP(3),
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
    "experiment_ref" TEXT,
    "targetScenarioId" TEXT,
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
CREATE TABLE "PromptAtom" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'core',
    "purpose" TEXT NOT NULL DEFAULT '',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "requires" TEXT NOT NULL DEFAULT '',
    "conflicts_with" TEXT NOT NULL DEFAULT '',
    "compatible_with" TEXT NOT NULL DEFAULT '',
    "conditions" TEXT,
    "parent" TEXT,
    "extends" TEXT NOT NULL DEFAULT '',
    "override" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "tags" TEXT NOT NULL DEFAULT '',
    "deprecated_by" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptAtom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptAtomVersion" (
    "id" TEXT NOT NULL,
    "atomId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "metadata" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptAtomVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scenario" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "tags" TEXT NOT NULL DEFAULT '',
    "required_atoms" TEXT NOT NULL DEFAULT '',
    "optional_atoms" TEXT NOT NULL DEFAULT '',
    "exclude_atoms" TEXT NOT NULL DEFAULT '',
    "max_atoms" INTEGER NOT NULL DEFAULT 12,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "status" TEXT NOT NULL DEFAULT 'published',
    "path" TEXT,
    "parent_id" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'seed',
    "experiment_count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3),
    "last_confirmed_at" TIMESTAMP(3),
    "status_reason" TEXT,
    "merged_into_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptCompositionPlan" (
    "id" TEXT NOT NULL,
    "compositionHash" TEXT NOT NULL,
    "scenarioId" TEXT,
    "userMessage" TEXT NOT NULL,
    "selected_atom_ids" TEXT NOT NULL DEFAULT '',
    "removed_atom_ids" TEXT NOT NULL DEFAULT '',
    "conflict_details" TEXT,
    "dependency_details" TEXT,
    "knowledge_required" BOOLEAN NOT NULL DEFAULT false,
    "verification_required" BOOLEAN NOT NULL DEFAULT false,
    "output_format" TEXT,
    "metadata" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptCompositionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTrace" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "userId" TEXT,
    "scenarioId" TEXT,
    "task" TEXT,
    "selected_atoms" TEXT NOT NULL DEFAULT '',
    "atom_versions" TEXT,
    "removed_atoms" TEXT NOT NULL DEFAULT '',
    "conflicts" TEXT,
    "dependencies" TEXT,
    "knowledge_state" TEXT,
    "knowledge_sources" TEXT,
    "verification_state" TEXT,
    "final_prompt_hash" TEXT NOT NULL,
    "target_model" TEXT,
    "composition_plan_id" TEXT,
    "decision_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioRelation" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "relation_type" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioPromptCompat" (
    "id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "atom_id" TEXT NOT NULL,
    "experiment_count" INTEGER NOT NULL DEFAULT 0,
    "unique_user_count" INTEGER NOT NULL DEFAULT 0,
    "positive_signals" INTEGER NOT NULL DEFAULT 0,
    "negative_signals" INTEGER NOT NULL DEFAULT 0,
    "correction_count" INTEGER NOT NULL DEFAULT 0,
    "regression_count" INTEGER NOT NULL DEFAULT 0,
    "success_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "best_version" TEXT,
    "lifecycle" TEXT NOT NULL DEFAULT 'experimental',
    "inherited" BOOLEAN NOT NULL DEFAULT false,
    "recent_performance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "last_evaluated" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScenarioPromptCompat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioSkillCompat" (
    "id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "skill_version" INTEGER,
    "experiment_count" INTEGER NOT NULL DEFAULT 0,
    "unique_user_count" INTEGER NOT NULL DEFAULT 0,
    "positive_signals" INTEGER NOT NULL DEFAULT 0,
    "negative_signals" INTEGER NOT NULL DEFAULT 0,
    "correction_count" INTEGER NOT NULL DEFAULT 0,
    "success_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "lifecycle" TEXT NOT NULL DEFAULT 'experimental',
    "inherited" BOOLEAN NOT NULL DEFAULT false,
    "recent_performance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "last_evaluated" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScenarioSkillCompat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillScenarioLink" (
    "id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "autoDerived" BOOLEAN NOT NULL DEFAULT true,
    "rationale" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillScenarioLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelectionDecision" (
    "id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "user_id" TEXT,
    "conversation_id" TEXT,
    "scenario_id" TEXT,
    "secondary_scenario_ids" TEXT NOT NULL DEFAULT '[]',
    "selected_atom_ids" TEXT NOT NULL DEFAULT '[]',
    "selected_skill_ids" TEXT NOT NULL DEFAULT '[]',
    "prompt_compat_snapshot" TEXT,
    "skill_compat_snapshot" TEXT,
    "model" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "fallback_reason" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "experiment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelectionDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentRun" (
    "id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scenario_id" TEXT,
    "atom_versions" TEXT NOT NULL DEFAULT '{}',
    "skill_versions" TEXT NOT NULL DEFAULT '[]',
    "model" TEXT,
    "input_context_hash" TEXT,
    "follow_up_id" TEXT,
    "feedback_signal" TEXT NOT NULL DEFAULT 'none',
    "outcome" TEXT NOT NULL DEFAULT 'unknown',
    "attribution_ref" TEXT,
    "experiment_type" TEXT NOT NULL DEFAULT 'real',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributionRecord" (
    "id" TEXT NOT NULL,
    "experiment_id" TEXT NOT NULL,
    "feedback_message_id" TEXT,
    "feedback_analysis" TEXT NOT NULL DEFAULT '{}',
    "skill_assessment" TEXT NOT NULL DEFAULT '{}',
    "attribution" TEXT NOT NULL DEFAULT '{}',
    "primary_cause" TEXT,
    "scenario_precision_delta" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "worth_evolving" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "description" TEXT,
    "aiCreated" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeObject" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "objectType" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeObjectCategory" (
    "objectId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "KnowledgeVariant" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "region" TEXT,
    "country" TEXT,
    "market" TEXT,
    "variantName" TEXT,
    "modelNumber" TEXT,
    "hardwareRevision" TEXT,
    "softwareChannel" TEXT,
    "version" TEXT,
    "sku" TEXT,
    "differenceSummary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFact" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "variantId" TEXT,
    "claim" TEXT NOT NULL,
    "claimType" TEXT NOT NULL DEFAULT 'OFFICIAL_FACT',
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "lifecycleStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "mergedInto" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "observedAt" TIMESTAMP(3),
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededBy" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactRefreshState" (
    "id" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "nextRefreshAt" TIMESTAMP(3) NOT NULL,
    "refreshIntervalMonths" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
    "lastRefreshAt" TIMESTAMP(3),
    "lastRefreshStatus" TEXT,
    "pausedUntil" TIMESTAMP(3),
    "unchangedStreak" INTEGER NOT NULL DEFAULT 0,
    "refreshCycle" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FactRefreshState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactLifecycleHistory" (
    "id" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changeType" TEXT,
    "evidenceIds" TEXT NOT NULL,
    "sourceIds" TEXT NOT NULL,
    "researchJobId" TEXT,
    "refreshTaskId" TEXT,
    "refreshCycle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactLifecycleHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccuracyGateDecision" (
    "id" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evidence" TEXT NOT NULL,
    "repairTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccuracyGateDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelScenarioCompatibility" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "compatibility" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "evidenceStrength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "experimentCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueUserCount" INTEGER NOT NULL DEFAULT 0,
    "userDistribution" TEXT NOT NULL DEFAULT '[]',
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "correctionCount" INTEGER NOT NULL DEFAULT 0,
    "verificationCount" INTEGER NOT NULL DEFAULT 0,
    "fallbackCount" INTEGER NOT NULL DEFAULT 0,
    "recentPerformance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "inherited" BOOLEAN NOT NULL DEFAULT false,
    "inheritedFromScenarioId" TEXT,
    "lastExperimentAt" TIMESTAMP(3),
    "poolVersion" TEXT,
    "semanticFit" TEXT,
    "status" TEXT NOT NULL DEFAULT 'experimental',
    "lastEvaluated" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelScenarioCompatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelScenarioDiversity" (
    "modelKey" TEXT NOT NULL,
    "stableCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelScenarioDiversity_pkey" PRIMARY KEY ("modelKey")
);

-- CreateTable
CREATE TABLE "ModelPoolVersion" (
    "id" TEXT NOT NULL,
    "versionHash" TEXT NOT NULL,
    "modelsJson" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelPoolVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceSource" (
    "id" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'WEB',
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "publisher" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "region" TEXT,
    "language" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "researchRecordId" TEXT,
    "variantId" TEXT,
    "content" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL DEFAULT 'TEXT',
    "observedAt" TIMESTAMP(3),
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFactEvidence" (
    "factId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ResearchRecord" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "variantId" TEXT,
    "researchScope" TEXT NOT NULL,
    "researchPlanJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "summary" TEXT,
    "conflictsJson" TEXT,
    "unknownsJson" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaReference" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "researchRecordId" TEXT,
    "mediaType" TEXT NOT NULL DEFAULT 'IMAGE',
    "sourceUrl" TEXT NOT NULL,
    "sourceTitle" TEXT,
    "observationType" TEXT NOT NULL DEFAULT 'VISUAL_OBSERVATION',
    "observation" TEXT,
    "measurementJson" TEXT,
    "timestampStart" DOUBLE PRECISION,
    "timestampEnd" DOUBLE PRECISION,
    "sourceAttribution" TEXT,
    "analysisResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeRelation" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "targetId" TEXT,
    "relationType" TEXT NOT NULL DEFAULT 'RELATED_TO',
    "description" TEXT,
    "lifecycleStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSnapshot" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "dataJson" TEXT,
    "manifestJson" TEXT,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationRecord" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "objectId" TEXT,
    "beforeSnapshotRef" TEXT NOT NULL,
    "afterSnapshotRef" TEXT NOT NULL,
    "beforeSnapshotHash" TEXT NOT NULL,
    "afterSnapshotHash" TEXT NOT NULL,
    "changesJson" TEXT NOT NULL,
    "issueTypes" TEXT NOT NULL,
    "beforeVersion" INTEGER NOT NULL,
    "afterVersion" INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationRecord_pkey" PRIMARY KEY ("id")
);

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
CREATE INDEX "RegionInsight_region_idx" ON "RegionInsight"("region");

-- CreateIndex
CREATE INDEX "EvolutionAudit_action_createdAt_idx" ON "EvolutionAudit"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvolutionBudget_date_key" ON "EvolutionBudget"("date");

-- CreateIndex
CREATE INDEX "PromptAtom_category_status_idx" ON "PromptAtom"("category", "status");

-- CreateIndex
CREATE INDEX "PromptAtom_status_idx" ON "PromptAtom"("status");

-- CreateIndex
CREATE INDEX "PromptAtomVersion_atomId_version_idx" ON "PromptAtomVersion"("atomId", "version");

-- CreateIndex
CREATE INDEX "PromptAtomVersion_atomId_status_idx" ON "PromptAtomVersion"("atomId", "status");

-- CreateIndex
CREATE INDEX "PromptAtomVersion_atomId_created_at_idx" ON "PromptAtomVersion"("atomId", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "PromptAtomVersion_atomId_version_key" ON "PromptAtomVersion"("atomId", "version");

-- CreateIndex
CREATE INDEX "Scenario_category_status_idx" ON "Scenario"("category", "status");

-- CreateIndex
CREATE INDEX "Scenario_status_idx" ON "Scenario"("status");

-- CreateIndex
CREATE INDEX "Scenario_parent_id_idx" ON "Scenario"("parent_id");

-- CreateIndex
CREATE INDEX "Scenario_path_idx" ON "Scenario"("path");

-- CreateIndex
CREATE UNIQUE INDEX "PromptCompositionPlan_compositionHash_key" ON "PromptCompositionPlan"("compositionHash");

-- CreateIndex
CREATE INDEX "PromptCompositionPlan_compositionHash_idx" ON "PromptCompositionPlan"("compositionHash");

-- CreateIndex
CREATE INDEX "PromptCompositionPlan_created_at_idx" ON "PromptCompositionPlan"("created_at");

-- CreateIndex
CREATE INDEX "PromptTrace_traceId_idx" ON "PromptTrace"("traceId");

-- CreateIndex
CREATE INDEX "PromptTrace_userId_created_at_idx" ON "PromptTrace"("userId", "created_at");

-- CreateIndex
CREATE INDEX "PromptTrace_requestId_idx" ON "PromptTrace"("requestId");

-- CreateIndex
CREATE INDEX "PromptTrace_status_created_at_idx" ON "PromptTrace"("status", "created_at");

-- CreateIndex
CREATE INDEX "ScenarioRelation_source_id_idx" ON "ScenarioRelation"("source_id");

-- CreateIndex
CREATE INDEX "ScenarioRelation_target_id_idx" ON "ScenarioRelation"("target_id");

-- CreateIndex
CREATE INDEX "ScenarioPromptCompat_scenario_id_success_rate_idx" ON "ScenarioPromptCompat"("scenario_id", "success_rate");

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioPromptCompat_scenario_id_atom_id_key" ON "ScenarioPromptCompat"("scenario_id", "atom_id");

-- CreateIndex
CREATE INDEX "ScenarioSkillCompat_scenario_id_success_rate_idx" ON "ScenarioSkillCompat"("scenario_id", "success_rate");

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioSkillCompat_scenario_id_skill_id_skill_version_key" ON "ScenarioSkillCompat"("scenario_id", "skill_id", "skill_version");

-- CreateIndex
CREATE INDEX "SkillScenarioLink_scenario_id_idx" ON "SkillScenarioLink"("scenario_id");

-- CreateIndex
CREATE UNIQUE INDEX "SkillScenarioLink_skill_id_scenario_id_key" ON "SkillScenarioLink"("skill_id", "scenario_id");

-- CreateIndex
CREATE INDEX "SelectionDecision_trace_id_idx" ON "SelectionDecision"("trace_id");

-- CreateIndex
CREATE INDEX "SelectionDecision_scenario_id_idx" ON "SelectionDecision"("scenario_id");

-- CreateIndex
CREATE INDEX "ExperimentRun_user_id_created_at_idx" ON "ExperimentRun"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ExperimentRun_scenario_id_idx" ON "ExperimentRun"("scenario_id");

-- CreateIndex
CREATE INDEX "ExperimentRun_decision_id_idx" ON "ExperimentRun"("decision_id");

-- CreateIndex
CREATE INDEX "AttributionRecord_experiment_id_idx" ON "AttributionRecord"("experiment_id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeCategory_name_key" ON "KnowledgeCategory"("name");

-- CreateIndex
CREATE INDEX "KnowledgeCategory_parentId_idx" ON "KnowledgeCategory"("parentId");

-- CreateIndex
CREATE INDEX "KnowledgeCategory_aiCreated_idx" ON "KnowledgeCategory"("aiCreated");

-- CreateIndex
CREATE INDEX "KnowledgeObject_objectType_idx" ON "KnowledgeObject"("objectType");

-- CreateIndex
CREATE INDEX "KnowledgeObject_status_idx" ON "KnowledgeObject"("status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeObject_canonicalName_key" ON "KnowledgeObject"("canonicalName");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeObjectCategory_objectId_categoryId_key" ON "KnowledgeObjectCategory"("objectId", "categoryId");

-- CreateIndex
CREATE INDEX "KnowledgeVariant_objectId_status_idx" ON "KnowledgeVariant"("objectId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeVariant_region_market_idx" ON "KnowledgeVariant"("region", "market");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVariant_objectId_variantName_modelNumber_key" ON "KnowledgeVariant"("objectId", "variantName", "modelNumber");

-- CreateIndex
CREATE INDEX "KnowledgeFact_objectId_claimType_idx" ON "KnowledgeFact"("objectId", "claimType");

-- CreateIndex
CREATE INDEX "KnowledgeFact_variantId_idx" ON "KnowledgeFact"("variantId");

-- CreateIndex
CREATE INDEX "KnowledgeFact_verificationStatus_idx" ON "KnowledgeFact"("verificationStatus");

-- CreateIndex
CREATE INDEX "KnowledgeFact_lifecycleStatus_idx" ON "KnowledgeFact"("lifecycleStatus");

-- CreateIndex
CREATE INDEX "KnowledgeFact_version_idx" ON "KnowledgeFact"("version");

-- CreateIndex
CREATE UNIQUE INDEX "FactRefreshState_factId_key" ON "FactRefreshState"("factId");

-- CreateIndex
CREATE INDEX "FactRefreshState_nextRefreshAt_archived_idx" ON "FactRefreshState"("nextRefreshAt", "archived");

-- CreateIndex
CREATE INDEX "FactRefreshState_refreshCycle_idx" ON "FactRefreshState"("refreshCycle");

-- CreateIndex
CREATE INDEX "FactLifecycleHistory_factId_createdAt_idx" ON "FactLifecycleHistory"("factId", "createdAt");

-- CreateIndex
CREATE INDEX "FactLifecycleHistory_eventType_createdAt_idx" ON "FactLifecycleHistory"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "AccuracyGateDecision_factId_createdAt_idx" ON "AccuracyGateDecision"("factId", "createdAt");

-- CreateIndex
CREATE INDEX "AccuracyGateDecision_verdict_createdAt_idx" ON "AccuracyGateDecision"("verdict", "createdAt");

-- CreateIndex
CREATE INDEX "ModelScenarioCompatibility_scenarioId_compatibility_idx" ON "ModelScenarioCompatibility"("scenarioId", "compatibility");

-- CreateIndex
CREATE INDEX "ModelScenarioCompatibility_status_evidenceStrength_idx" ON "ModelScenarioCompatibility"("status", "evidenceStrength");

-- CreateIndex
CREATE INDEX "ModelScenarioCompatibility_modelId_idx" ON "ModelScenarioCompatibility"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelScenarioCompatibility_modelId_scenarioId_key" ON "ModelScenarioCompatibility"("modelId", "scenarioId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelPoolVersion_versionHash_key" ON "ModelPoolVersion"("versionHash");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceSource_canonicalUrl_key" ON "EvidenceSource"("canonicalUrl");

-- CreateIndex
CREATE INDEX "EvidenceSource_domain_idx" ON "EvidenceSource"("domain");

-- CreateIndex
CREATE INDEX "EvidenceSource_sourceType_idx" ON "EvidenceSource"("sourceType");

-- CreateIndex
CREATE INDEX "EvidenceSource_isOfficial_idx" ON "EvidenceSource"("isOfficial");

-- CreateIndex
CREATE INDEX "Evidence_sourceId_idx" ON "Evidence"("sourceId");

-- CreateIndex
CREATE INDEX "Evidence_variantId_idx" ON "Evidence"("variantId");

-- CreateIndex
CREATE INDEX "Evidence_researchRecordId_idx" ON "Evidence"("researchRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFactEvidence_factId_evidenceId_key" ON "KnowledgeFactEvidence"("factId", "evidenceId");

-- CreateIndex
CREATE INDEX "ResearchRecord_objectId_status_idx" ON "ResearchRecord"("objectId", "status");

-- CreateIndex
CREATE INDEX "ResearchRecord_variantId_idx" ON "ResearchRecord"("variantId");

-- CreateIndex
CREATE INDEX "MediaReference_objectId_mediaType_idx" ON "MediaReference"("objectId", "mediaType");

-- CreateIndex
CREATE INDEX "MediaReference_researchRecordId_idx" ON "MediaReference"("researchRecordId");

-- CreateIndex
CREATE INDEX "KnowledgeRelation_objectId_idx" ON "KnowledgeRelation"("objectId");

-- CreateIndex
CREATE INDEX "KnowledgeRelation_targetId_idx" ON "KnowledgeRelation"("targetId");

-- CreateIndex
CREATE INDEX "KnowledgeRelation_lifecycleStatus_idx" ON "KnowledgeRelation"("lifecycleStatus");

-- CreateIndex
CREATE INDEX "OrganizationSnapshot_scopeType_scopeId_idx" ON "OrganizationSnapshot"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "OrganizationRecord_scopeType_scopeId_idx" ON "OrganizationRecord"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "OrganizationRecord_jobId_idx" ON "OrganizationRecord"("jobId");

-- CreateIndex
CREATE INDEX "OrganizationRecord_objectId_idx" ON "OrganizationRecord"("objectId");

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "KnowledgeFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptAtomVersion" ADD CONSTRAINT "PromptAtomVersion_atomId_fkey" FOREIGN KEY ("atomId") REFERENCES "PromptAtom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeCategory" ADD CONSTRAINT "KnowledgeCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "KnowledgeCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeObjectCategory" ADD CONSTRAINT "KnowledgeObjectCategory_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeObjectCategory" ADD CONSTRAINT "KnowledgeObjectCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "KnowledgeCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVariant" ADD CONSTRAINT "KnowledgeVariant_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFact" ADD CONSTRAINT "KnowledgeFact_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFact" ADD CONSTRAINT "KnowledgeFact_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "KnowledgeVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "EvidenceSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_researchRecordId_fkey" FOREIGN KEY ("researchRecordId") REFERENCES "ResearchRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "KnowledgeVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFactEvidence" ADD CONSTRAINT "KnowledgeFactEvidence_factId_fkey" FOREIGN KEY ("factId") REFERENCES "KnowledgeFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFactEvidence" ADD CONSTRAINT "KnowledgeFactEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRecord" ADD CONSTRAINT "ResearchRecord_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRecord" ADD CONSTRAINT "ResearchRecord_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "KnowledgeVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaReference" ADD CONSTRAINT "MediaReference_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaReference" ADD CONSTRAINT "MediaReference_researchRecordId_fkey" FOREIGN KEY ("researchRecordId") REFERENCES "ResearchRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRelation" ADD CONSTRAINT "KnowledgeRelation_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRelation" ADD CONSTRAINT "KnowledgeRelation_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "KnowledgeObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Vector embeddings moved to Postgres (2026-10-12): replaces local sqlite-vec store
CREATE TABLE IF NOT EXISTS "KnowledgeEmbedding" (
    "id" TEXT NOT NULL,
    "knowledgeId" TEXT NOT NULL,
    "vectorJson" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeEmbedding_knowledgeId_key" ON "KnowledgeEmbedding"("knowledgeId");

