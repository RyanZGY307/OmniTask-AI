// ================================================================
// Scenario Registry — 200+ scenario definitions
// Each scenario is a Prompt Atom combination definition.
// ================================================================

import { prismaKnowledge } from './db';

export interface ScenarioInput {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  required_atoms: string[];
  optional_atoms?: string[];
  exclude_atoms?: string[];
  max_atoms?: number;
  priority?: number;
  status?: string;
}

export const DEFAULT_SCENARIOS: ScenarioInput[] = [
  // Core (1-20)
  { id: 'general.chat', name: 'General Chat', category: 'core', required_atoms: ['core.identity'], optional_atoms: ['core.concise'], priority: 100 },
  { id: 'general.qa', name: 'Q&A', category: 'core', required_atoms: ['core.identity', 'core.answer_quality'], optional_atoms: ['knowledge.database_first'], priority: 100 },
  { id: 'core.identity', name: 'Identity', category: 'core', required_atoms: [], priority: 100 },
  { id: 'core.answer_quality', name: 'Answer Quality', category: 'core', required_atoms: [], priority: 95 },
  { id: 'core.context_aware', name: 'Context Aware', category: 'core', required_atoms: [], priority: 90 },
  { id: 'core.safety', name: 'Safety First', category: 'core', required_atoms: [], priority: 100 },
  { id: 'core.concise', name: 'Be Concise', category: 'core', required_atoms: [], priority: 60 },
  { id: 'core.truth_standard', name: 'Truth Standard', category: 'core', required_atoms: [], priority: 100 },
  // Chat (21-35)
  { id: 'chat.simple', name: 'Simple Chat', category: 'chat', required_atoms: ['core.identity'], optional_atoms: ['core.concise'], priority: 80 },
  { id: 'chat.casual', name: 'Casual Chat', category: 'chat', required_atoms: ['core.identity'], optional_atoms: ['output.casual'], priority: 70 },
  { id: 'chat.formal', name: 'Formal Chat', category: 'chat', required_atoms: ['core.identity'], optional_atoms: ['output.formal'], priority: 70 },
  { id: 'chat.friend', name: 'Friendly Chat', category: 'chat', required_atoms: ['core.identity'], optional_atoms: ['output.casual', 'core.concise'], priority: 65 },
  { id: 'chat.coaching', name: 'Coaching Chat', category: 'chat', required_atoms: ['core.identity'], optional_atoms: ['task.coaching'], priority: 75 },
  { id: 'chat.debate', name: 'Debate', category: 'chat', required_atoms: ['core.identity'], optional_atoms: ['task.analysis', 'output.argumentative'], priority: 70 },
  { id: 'chat.storytelling', name: 'Storytelling', category: 'chat', required_atoms: ['core.identity'], optional_atoms: ['task.creative', 'output.narrative'], priority: 65 },
  // Q&A (36-50)
  { id: 'qa.knowledge', name: 'Knowledge Q&A', category: 'qa', required_atoms: ['core.identity', 'core.answer_quality'], optional_atoms: ['knowledge.database_first', 'knowledge.freshness_check'], priority: 90 },
  { id: 'qa.technical', name: 'Technical Q&A', category: 'qa', required_atoms: ['core.identity', 'core.answer_quality'], optional_atoms: ['task.technical', 'knowledge.database_first'], priority: 85 },
  { id: 'qa.scientific', name: 'Scientific Q&A', category: 'qa', required_atoms: ['core.identity', 'core.answer_quality'], optional_atoms: ['verification.fact', 'research.multi_source'], priority: 85 },
  { id: 'qa.math', name: 'Math Q&A', category: 'qa', required_atoms: ['core.identity', 'core.answer_quality'], optional_atoms: ['task.math', 'verification.fact'], priority: 85 },
  { id: 'qa.law', name: 'Legal Q&A', category: 'qa', required_atoms: ['core.identity', 'core.answer_quality'], optional_atoms: ['verification.source', 'knowledge.legal'], priority: 80 },
  { id: 'qa.medical', name: 'Medical Q&A', category: 'qa', required_atoms: ['core.identity', 'core.answer_quality'], optional_atoms: ['verification.fact', 'core.safety'], priority: 80 },
  { id: 'qa.history', name: 'Historical Q&A', category: 'qa', required_atoms: ['core.identity', 'core.answer_quality'], optional_atoms: ['verification.source', 'research.multi_source'], priority: 75 },
  { id: 'qa.current_events', name: 'Current Events', category: 'qa', required_atoms: ['core.identity', 'core.answer_quality'], optional_atoms: ['knowledge.freshness_check', 'research.multi_source'], priority: 80 },
  // Explanation (51-65)
  { id: 'explanation.technical_concept', name: 'Technical Concept Explanation', category: 'explanation', required_atoms: ['core.identity', 'task.explanation', 'technical.clear_explanation'], optional_atoms: ['knowledge.database_first'], priority: 90 },
  { id: 'explanation.simple', name: 'Simple Explanation', category: 'explanation', required_atoms: ['core.identity', 'task.explanation'], optional_atoms: ['output.concise'], priority: 85 },
  { id: 'explanation.deep', name: 'Deep Explanation', category: 'explanation', required_atoms: ['core.identity', 'task.explanation'], optional_atoms: ['task.analysis', 'verification.fact'], priority: 80 },
  { id: 'explanation.beginner', name: 'Beginner Explanation', category: 'explanation', required_atoms: ['core.identity', 'task.explanation'], optional_atoms: ['output.simple_language'], priority: 85 },
  { id: 'explanation.expert', name: 'Expert Explanation', category: 'explanation', required_atoms: ['core.identity', 'task.explanation'], optional_atoms: ['task.technical', 'verification.source'], priority: 80 },
  // Analysis (66-80)
  { id: 'analysis.data', name: 'Data Analysis', category: 'analysis', required_atoms: ['core.identity', 'task.analysis'], optional_atoms: ['verification.fact', 'output.structured'], priority: 85 },
  { id: 'analysis.text', name: 'Text Analysis', category: 'analysis', required_atoms: ['core.identity', 'task.analysis'], optional_atoms: ['output.structured'], priority: 80 },
  { id: 'analysis.code', name: 'Code Analysis', category: 'analysis', required_atoms: ['core.identity', 'task.analysis', 'task.code_analysis'], optional_atoms: ['knowledge.database_first'], priority: 85 },
  { id: 'analysis.document', name: 'Document Analysis', category: 'analysis', required_atoms: ['core.identity', 'task.analysis'], optional_atoms: ['knowledge.database_first', 'output.structured'], priority: 80 },
  { id: 'analysis.comparative', name: 'Comparative Analysis', category: 'analysis', required_atoms: ['core.identity', 'task.analysis', 'task.comparison'], optional_atoms: ['output.structured'], priority: 85 },
  { id: 'analysis.swot', name: 'SWOT Analysis', category: 'analysis', required_atoms: ['core.identity', 'task.analysis', 'task.comparison'], optional_atoms: ['output.structured'], priority: 75 },
  { id: 'analysis.risk', name: 'Risk Analysis', category: 'analysis', required_atoms: ['core.identity', 'task.analysis'], optional_atoms: ['verification.fact', 'output.structured'], priority: 80 },
  { id: 'analysis.cost', name: 'Cost Analysis', category: 'analysis', required_atoms: ['core.identity', 'task.analysis'], optional_atoms: ['task.math', 'output.structured'], priority: 75 },
  { id: 'analysis.technical选型', name: 'Technical Selection Analysis', category: 'analysis', required_atoms: ['core.identity', 'task.analysis', 'task.comparison'], optional_atoms: ['knowledge.database_first'], priority: 85 },
  // Research (81-100)
  { id: 'research.standard', name: 'Standard Research', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['knowledge.database_first', 'research.multi_source'], priority: 90 },
  { id: 'research.fact_check', name: 'Fact Checking', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['verification.fact', 'verification.source', 'research.multi_source'], priority: 95 },
  { id: 'research.deep', name: 'Deep Research', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['research.multi_source', 'knowledge.freshness_check'], priority: 90 },
  { id: 'research.academic', name: 'Academic Research', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['verification.source', 'research.multi_source', 'output.academic'], priority: 90 },
  { id: 'research.market', name: 'Market Research', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['knowledge.freshness_check', 'research.multi_source'], priority: 80 },
  { id: 'research.scientific', name: 'Scientific Research', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['verification.fact', 'research.multi_source'], priority: 90 },
  { id: 'research.literature', name: 'Literature Review', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['verification.source', 'output.academic'], priority: 80 },
  { id: 'research.compound', name: 'Compound Research', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['research.multi_source', 'knowledge.database_first'], priority: 85 },
  { id: 'research.source_validation', name: 'Source Validation', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['verification.source'], priority: 85 },
  { id: 'research.cross_reference', name: 'Cross-Reference Research', category: 'research', required_atoms: ['core.identity', 'task.research'], optional_atoms: ['research.multi_source', 'verification.fact'], priority: 85 },
  // Writing (101-120)
  { id: 'writing.article', name: 'Article Writing', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['output.structured'], priority: 85 },
  { id: 'writing.report', name: 'Report Writing', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['output.structured', 'verification.fact'], priority: 85 },
  { id: 'writing.email', name: 'Email Writing', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['output.email'], priority: 80 },
  { id: 'writing.social', name: 'Social Media Post', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['output.concise', 'output.social'], priority: 70 },
  { id: 'writing.blog', name: 'Blog Writing', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['output.structured'], priority: 75 },
  { id: 'writing.proposal', name: 'Proposal Writing', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['output.structured', 'task.analysis'], priority: 80 },
  { id: 'writing.resume', name: 'Resume Writing', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['output.structured'], priority: 75 },
  { id: 'writing.cover_letter', name: 'Cover Letter', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['output.formal'], priority: 70 },
  { id: 'writing.legal', name: 'Legal Document Writing', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['verification.source', 'output.formal'], priority: 80 },
  { id: 'writing.creative', name: 'Creative Writing', category: 'writing', required_atoms: ['core.identity', 'task.writing'], optional_atoms: ['output.narrative'], priority: 70 },
  // Translation (121-130)
  { id: 'translation.standard', name: 'Standard Translation', category: 'translation', required_atoms: ['core.identity', 'task.translation'], optional_atoms: [], priority: 85 },
  { id: 'translation.technical', name: 'Technical Translation', category: 'translation', required_atoms: ['core.identity', 'task.translation'], optional_atoms: ['knowledge.database_first'], priority: 85 },
  { id: 'translation.localize', name: 'Localization', category: 'translation', required_atoms: ['core.identity', 'task.translation'], optional_atoms: ['output.cultural_adaptation'], priority: 80 },
  { id: 'translation.industry', name: 'Industry-Specific Translation', category: 'translation', required_atoms: ['core.identity', 'task.translation'], optional_atoms: ['knowledge.domain_specific'], priority: 80 },
  // Code (131-155)
  { id: 'code.generate', name: 'Code Generation', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], optional_atoms: ['knowledge.database_first'], priority: 90 },
  { id: 'code.analyze', name: 'Code Analysis', category: 'code', required_atoms: ['core.identity', 'task.code_analysis'], optional_atoms: [], priority: 85 },
  { id: 'code.debug', name: 'Code Debugging', category: 'code', required_atoms: ['core.identity', 'task.code_debugging'], optional_atoms: ['verification.fact'], priority: 90 },
  { id: 'code.review', name: 'Code Review', category: 'code', required_atoms: ['core.identity', 'task.code_review'], optional_atoms: ['verification.fact'], priority: 85 },
  { id: 'code.refactor', name: 'Code Refactoring', category: 'code', required_atoms: ['core.identity', 'task.code_refactoring'], optional_atoms: [], priority: 80 },
  { id: 'code.optimize', name: 'Code Optimization', category: 'code', required_atoms: ['core.identity', 'task.code_optimization'], optional_atoms: ['verification.fact'], priority: 80 },
  { id: 'code.test', name: 'Test Writing', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], optional_atoms: ['verification.fact'], priority: 80 },
  { id: 'code.api', name: 'API Development', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], optional_atoms: ['knowledge.database_first'], priority: 85 },
  { id: 'code.frontend', name: 'Frontend Development', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], optional_atoms: [], priority: 80 },
  { id: 'code.backend', name: 'Backend Development', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], optional_atoms: ['knowledge.database_first'], priority: 80 },
  { id: 'code.mobile', name: 'Mobile Development', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], optional_atoms: [], priority: 75 },
  { id: 'code.devops', name: 'DevOps', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], optional_atoms: ['knowledge.database_first'], priority: 75 },
  { id: 'code.security', name: 'Security Analysis', category: 'code', required_atoms: ['core.identity', 'task.code_analysis'], optional_atoms: ['verification.fact', 'core.safety'], priority: 90 },
  { id: 'code.architecture', name: 'Architecture Design', category: 'code', required_atoms: ['core.identity', 'task.analysis'], optional_atoms: ['knowledge.database_first', 'output.structured'], priority: 85 },
  { id: 'code.performance', name: 'Performance Tuning', category: 'code', required_atoms: ['core.identity', 'task.code_analysis'], optional_atoms: ['verification.fact'], priority: 80 },
  // Math & Science (156-170)
  { id: 'math.calculation', name: 'Math Calculation', category: 'math', required_atoms: ['core.identity', 'task.math'], optional_atoms: ['verification.fact'], priority: 90 },
  { id: 'math.formula', name: 'Formula Derivation', category: 'math', required_atoms: ['core.identity', 'task.math'], optional_atoms: ['verification.fact'], priority: 85 },
  { id: 'science.physics', name: 'Physics', category: 'science', required_atoms: ['core.identity', 'task.explanation'], optional_atoms: ['verification.fact', 'knowledge.database_first'], priority: 85 },
  { id: 'science.chemistry', name: 'Chemistry', category: 'science', required_atoms: ['core.identity', 'task.explanation'], optional_atoms: ['verification.fact'], priority: 80 },
  { id: 'science.biology', name: 'Biology', category: 'science', required_atoms: ['core.identity', 'task.explanation'], optional_atoms: ['verification.fact'], priority: 80 },
  { id: 'science.earth', name: 'Earth Science', category: 'science', required_atoms: ['core.identity', 'task.explanation'], optional_atoms: ['verification.fact'], priority: 75 },
  // Summary (171-180)
  { id: 'summary.short', name: 'Short Summary', category: 'summary', required_atoms: ['core.identity', 'task.summary'], optional_atoms: ['output.concise'], priority: 80 },
  { id: 'summary.long', name: 'Long Summary', category: 'summary', required_atoms: ['core.identity', 'task.summary'], optional_atoms: ['output.structured'], priority: 80 },
  { id: 'summary.bullet', name: 'Bullet Summary', category: 'summary', required_atoms: ['core.identity', 'task.summary'], optional_atoms: ['output.bullet_points'], priority: 80 },
  // Verification (181-190)
  { id: 'verify.fact', name: 'Fact Verification', category: 'verification', required_atoms: ['core.identity', 'verification.fact'], optional_atoms: ['verification.source'], priority: 95 },
  { id: 'verify.source', name: 'Source Verification', category: 'verification', required_atoms: ['core.identity', 'verification.source'], optional_atoms: [], priority: 90 },
  { id: 'verify.output', name: 'Output Verification', category: 'verification', required_atoms: ['core.identity', 'verification.fact'], optional_atoms: [], priority: 85 },
  // Output formats (191-200)
  { id: 'output.structured', name: 'Structured Output', category: 'output', required_atoms: ['output.structured_format'], priority: 70 },
  { id: 'output.concise', name: 'Concise Output', category: 'output', required_atoms: ['output.concise_format'], priority: 70 },
  { id: 'output.table', name: 'Table Output', category: 'output', required_atoms: ['output.table_format'], priority: 65 },
  { id: 'output.code', name: 'Code Output', category: 'output', required_atoms: ['output.code_format'], priority: 70 },
  { id: 'output.json', name: 'JSON Output', category: 'output', required_atoms: ['output.json_format'], priority: 65 },
  { id: 'output.md', name: 'Markdown Output', category: 'output', required_atoms: ['output.md_format'], priority: 65 },
  { id: 'output.academic', name: 'Academic Output', category: 'output', required_atoms: ['output.academic_format'], priority: 70 },
  { id: 'output.casual', name: 'Casual Output', category: 'output', required_atoms: ['output.casual_format'], priority: 60 },
  { id: 'output.formal', name: 'Formal Output', category: 'output', required_atoms: ['output.formal_format'], priority: 60 },
  { id: 'output.narrative', name: 'Narrative Output', category: 'output', required_atoms: ['output.narrative_format'], priority: 60 },
  { id: 'recommendation.one', name: 'Recommend One', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation', 'recommendation.criteria'], optional_atoms: ['knowledge.database_first'], priority: 85 },
  { id: 'recommendation.several', name: 'Recommend Several', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation', 'task.multi_option'], optional_atoms: ['knowledge.database_first'], priority: 85 },
  { id: 'recommendation.best_fit', name: 'Best Fit', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation', 'recommendation.constraint_matching'], priority: 85 },
  { id: 'recommendation.budget', name: 'Budget Rec', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation'], priority: 80 },
  { id: 'recommendation.current', name: 'Current Best', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation'], optional_atoms: ['knowledge.freshness_check'], priority: 80 },
  { id: 'recommendation.alternative', name: 'Alternative', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation'], priority: 80 },
  { id: 'recommendation.shortlist', name: 'Shortlist', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation', 'task.shortlist'], priority: 85 },
  { id: 'recommendation.with_reason', name: 'With Reasoning', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation', 'output.structured'], priority: 85 },
  { id: 'recommendation.comparison', name: 'Rec Comparison', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation', 'task.comparison'], priority: 85 },
  { id: 'recommendation.product', name: 'Product Rec', category: 'recommendation', required_atoms: ['core.identity', 'task.recommendation'], priority: 80 },
  { id: 'comparison.feature', name: 'Feature Comparison', category: 'comparison', required_atoms: ['core.identity', 'task.comparison', 'output.comparison_table'], priority: 80 },
  { id: 'comparison.performance', name: 'Performance Comparison', category: 'comparison', required_atoms: ['core.identity', 'task.comparison', 'verification.fact'], priority: 80 },
  { id: 'comparison.cost', name: 'Cost Comparison', category: 'comparison', required_atoms: ['core.identity', 'task.comparison'], priority: 80 },
  { id: 'comparison.quality', name: 'Quality Comparison', category: 'comparison', required_atoms: ['core.identity', 'task.comparison'], priority: 80 },
  { id: 'comparison.multi', name: 'Multi-Item Comparison', category: 'comparison', required_atoms: ['core.identity', 'task.comparison', 'task.multi_option'], priority: 80 },
  { id: 'comparison.a_b', name: 'A vs B', category: 'comparison', required_atoms: ['core.identity', 'task.comparison'], priority: 80 },
  { id: 'comparison.product', name: 'Product Comparison', category: 'comparison', required_atoms: ['core.identity', 'task.comparison'], priority: 80 },
  { id: 'comparison.technology', name: 'Tech Comparison', category: 'comparison', required_atoms: ['core.identity', 'task.comparison'], priority: 80 },
  { id: 'multi_option.ranked', name: 'Ranked Options', category: 'multi_option', required_atoms: ['core.identity', 'task.multi_option'], priority: 80 },
  { id: 'multi_option.tradeoff', name: 'Tradeoff Options', category: 'multi_option', required_atoms: ['core.identity', 'task.multi_option', 'task.comparison'], priority: 80 },
  { id: 'multi_option.budget', name: 'Budget Options', category: 'multi_option', required_atoms: ['core.identity', 'task.multi_option'], priority: 75 },
  { id: 'multi_option.risk', name: 'Risk Options', category: 'multi_option', required_atoms: ['core.identity', 'task.multi_option'], priority: 80 },
  { id: 'multi_option.speed', name: 'Speed Options', category: 'multi_option', required_atoms: ['core.identity', 'task.multi_option'], priority: 75 },
  { id: 'multi_option.quality', name: 'Quality Options', category: 'multi_option', required_atoms: ['core.identity', 'task.multi_option'], priority: 75 },
  { id: 'multi_option.fallback', name: 'Fallback Options', category: 'multi_option', required_atoms: ['core.identity', 'task.multi_option'], priority: 75 },
  { id: 'multi_option.comprehensive', name: 'Comprehensive Options', category: 'multi_option', required_atoms: ['core.identity', 'task.multi_option'], priority: 80 },
  { id: 'decision.support', name: 'Decision Support', category: 'decision', required_atoms: ['core.identity', 'task.decision_support'], priority: 85 },
  { id: 'decision.pros_cons', name: 'Pros and Cons', category: 'decision', required_atoms: ['core.identity', 'task.pros_cons'], priority: 80 },
  { id: 'decision.tradeoff', name: 'Tradeoff Analysis', category: 'decision', required_atoms: ['core.identity', 'task.tradeoff_analysis'], priority: 80 },
  { id: 'planning.project', name: 'Project Planning', category: 'planning', required_atoms: ['core.identity', 'task.planning'], priority: 80 },
  { id: 'planning.task', name: 'Task Planning', category: 'planning', required_atoms: ['core.identity', 'task.planning'], priority: 80 },
  { id: 'planning.schedule', name: 'Scheduling', category: 'planning', required_atoms: ['core.identity', 'task.scheduling'], priority: 75 },
  { id: 'planning.strategy', name: 'Strategy Planning', category: 'planning', required_atoms: ['core.identity', 'task.strategy'], priority: 80 },
  { id: 'brainstorm.idea', name: 'Idea Brainstorm', category: 'brainstorm', required_atoms: ['core.identity', 'task.brainstorming'], priority: 75 },
  { id: 'brainstorm.creative', name: 'Creative Brainstorm', category: 'brainstorm', required_atoms: ['core.identity', 'task.brainstorming', 'task.ideation'], priority: 75 },
  { id: 'brainstorm.naming', name: 'Naming', category: 'brainstorm', required_atoms: ['core.identity', 'task.naming'], priority: 70 },
  { id: 'design.concept', name: 'Concept Design', category: 'design', required_atoms: ['core.identity', 'task.design_generation'], priority: 75 },
  { id: 'writing.blog', name: 'Blog Post', category: 'writing', required_atoms: ['core.identity', 'task.writing'], priority: 75 },
  { id: 'writing.novel', name: 'Fiction', category: 'writing', required_atoms: ['core.identity', 'task.creative_writing'], priority: 70 },
  { id: 'writing.poetry', name: 'Poetry', category: 'writing', required_atoms: ['core.identity', 'task.creative_writing'], priority: 70 },
  { id: 'writing.script', name: 'Screenplay', category: 'writing', required_atoms: ['core.identity', 'task.creative_writing'], priority: 70 },
  { id: 'writing.press', name: 'Press Release', category: 'writing', required_atoms: ['core.identity', 'task.writing'], priority: 70 },
  { id: 'writing.case_study', name: 'Case Study', category: 'writing', required_atoms: ['core.identity', 'task.writing', 'task.analysis'], priority: 75 },
  { id: 'writing.whitepaper', name: 'Whitepaper', category: 'writing', required_atoms: ['core.identity', 'task.writing', 'task.research'], priority: 80 },
  { id: 'writing.speech', name: 'Speech', category: 'writing', required_atoms: ['core.identity', 'task.creative_writing'], priority: 70 },
  { id: 'writing.legal_doc', name: 'Legal Document', category: 'writing', required_atoms: ['core.identity', 'task.writing'], priority: 80 },
  { id: 'writing.contract', name: 'Contract', category: 'writing', required_atoms: ['core.identity', 'task.writing'], priority: 85 },
  { id: 'translation.technical', name: 'Technical Translation', category: 'translation', required_atoms: ['core.identity', 'task.translation'], priority: 80 },
  { id: 'translation.literary', name: 'Literary Translation', category: 'translation', required_atoms: ['core.identity', 'task.translation'], priority: 75 },
  { id: 'translation.business', name: 'Business Translation', category: 'translation', required_atoms: ['core.identity', 'task.translation'], priority: 80 },
  { id: 'translation.legal', name: 'Legal Translation', category: 'translation', required_atoms: ['core.identity', 'task.translation'], priority: 80 },
  { id: 'translation.medical', name: 'Medical Translation', category: 'translation', required_atoms: ['core.identity', 'task.translation'], priority: 80 },
  { id: 'localization.ui', name: 'UI Localization', category: 'localization', required_atoms: ['core.identity', 'task.localization'], priority: 75 },
  { id: 'localization.cultural', name: 'Cultural Adaptation', category: 'localization', required_atoms: ['core.identity', 'task.localization'], priority: 75 },
  { id: 'math.algebra', name: 'Algebra', category: 'math', required_atoms: ['core.identity', 'task.math'], priority: 85 },
  { id: 'math.calculus', name: 'Calculus', category: 'math', required_atoms: ['core.identity', 'task.math'], priority: 85 },
  { id: 'math.statistics', name: 'Statistics', category: 'math', required_atoms: ['core.identity', 'task.math', 'task.data_analysis'], priority: 85 },
  { id: 'math.probability', name: 'Probability', category: 'math', required_atoms: ['core.identity', 'task.math'], priority: 85 },
  { id: 'math.geometry', name: 'Geometry', category: 'math', required_atoms: ['core.identity', 'task.math'], priority: 85 },
  { id: 'science.mechanics', name: 'Mechanics', category: 'science', required_atoms: ['core.identity', 'task.explanation'], priority: 80 },
  { id: 'science.organic', name: 'Organic Chemistry', category: 'science', required_atoms: ['core.identity', 'task.explanation'], priority: 80 },
  { id: 'science.molecular', name: 'Molecular Biology', category: 'science', required_atoms: ['core.identity', 'task.explanation'], priority: 80 },
  { id: 'science.astronomy', name: 'Astronomy', category: 'science', required_atoms: ['core.identity', 'task.explanation'], priority: 75 },
  { id: 'science.climate', name: 'Climate', category: 'science', required_atoms: ['core.identity', 'task.explanation'], priority: 80 },
  { id: 'data.visualization', name: 'Data Visualization', category: 'data', required_atoms: ['core.identity', 'task.data_analysis'], priority: 80 },
  { id: 'data.cleansing', name: 'Data Cleansing', category: 'data', required_atoms: ['core.identity', 'task.data_validation'], priority: 75 },
  { id: 'data.etl', name: 'ETL Pipeline', category: 'data', required_atoms: ['core.identity', 'task.data_transformation'], priority: 75 },
  { id: 'data.sql', name: 'SQL Query', category: 'data', required_atoms: ['core.identity', 'task.code_generation'], priority: 80 },
  { id: 'code.python', name: 'Python', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 85 },
  { id: 'code.javascript', name: 'JavaScript', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 85 },
  { id: 'code.typescript', name: 'TypeScript', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 85 },
  { id: 'code.rust', name: 'Rust', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 80 },
  { id: 'code.go', name: 'Go', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 80 },
  { id: 'code.java', name: 'Java', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 80 },
  { id: 'code.c_cpp', name: 'C/C++', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 80 },
  { id: 'code.ruby', name: 'Ruby', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'code.swift', name: 'Swift', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'code.kotlin', name: 'Kotlin', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'code.regex', name: 'Regex', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'code.shell', name: 'Shell Script', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'code.unit_test', name: 'Unit Test', category: 'code', required_atoms: ['core.identity', 'task.code_generation', 'task.test'], priority: 80 },
  { id: 'code.integration_test', name: 'Integration Test', category: 'code', required_atoms: ['core.identity', 'task.code_generation', 'task.test'], priority: 75 },
  { id: 'code.api_design', name: 'API Design', category: 'code', required_atoms: ['core.identity', 'task.code_generation', 'task.architecture_analysis'], priority: 80 },
  { id: 'code.rest', name: 'REST API', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 80 },
  { id: 'code.graphql', name: 'GraphQL', category: 'code', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'code.microservice', name: 'Microservice', category: 'code', required_atoms: ['core.identity', 'task.architecture_analysis'], priority: 80 },
  { id: 'code.database_design', name: 'Database Design', category: 'code', required_atoms: ['core.identity', 'task.architecture_analysis'], priority: 80 },
  { id: 'code.security_audit', name: 'Security Audit', category: 'code', required_atoms: ['core.identity', 'task.security_audit', 'core.safety'], priority: 90 },
  { id: 'code.memory_leak', name: 'Memory Leak', category: 'code', required_atoms: ['core.identity', 'task.code_debugging'], priority: 85 },
  { id: 'devops.ci_cd', name: 'CI/CD', category: 'devops', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'devops.docker', name: 'Docker', category: 'devops', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'devops.k8s', name: 'Kubernetes', category: 'devops', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'devops.monitoring', name: 'Monitoring', category: 'devops', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'devops.terraform', name: 'Terraform', category: 'devops', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'devops.cloud', name: 'Cloud Config', category: 'devops', required_atoms: ['core.identity', 'task.code_generation'], priority: 75 },
  { id: 'file.pdf', name: 'PDF Analysis', category: 'file', required_atoms: ['core.identity', 'task.file_analysis'], priority: 80 },
  { id: 'file.excel', name: 'Excel Analysis', category: 'file', required_atoms: ['core.identity', 'task.file_analysis', 'task.data_analysis'], priority: 80 },
  { id: 'file.csv', name: 'CSV Analysis', category: 'file', required_atoms: ['core.identity', 'task.file_analysis', 'task.data_analysis'], priority: 80 },
  { id: 'file.image_ocr', name: 'Image OCR', category: 'file', required_atoms: ['core.identity', 'task.image_analysis'], priority: 80 },
  { id: 'file.image_understand', name: 'Image Understanding', category: 'file', required_atoms: ['core.identity', 'task.image_analysis'], priority: 80 },
  { id: 'file.chart_read', name: 'Chart Reading', category: 'file', required_atoms: ['core.identity', 'task.chart_analysis'], priority: 80 },
  { id: 'file.video', name: 'Video Analysis', category: 'file', required_atoms: ['core.identity', 'task.video_analysis'], priority: 75 },
  { id: 'file.audio', name: 'Audio Transcription', category: 'file', required_atoms: ['core.identity', 'task.audio_analysis'], priority: 75 },
  { id: 'audio.transcription', name: 'Audio Transcription', category: 'audio', required_atoms: ['core.identity', 'task.audio_analysis'], priority: 75 },
  { id: 'video.understanding', name: 'Video Understanding', category: 'video', required_atoms: ['core.identity', 'task.video_analysis'], priority: 75 },
  { id: 'video.summary', name: 'Video Summary', category: 'video', required_atoms: ['core.identity', 'task.video_analysis', 'task.summary'], priority: 75 },
  { id: 'research.legal', name: 'Legal Research', category: 'research', required_atoms: ['core.identity', 'task.research', 'verification.source'], priority: 85 },
  { id: 'research.medical', name: 'Medical Research', category: 'research', required_atoms: ['core.identity', 'task.research', 'verification.fact'], priority: 90 },
  { id: 'research.financial', name: 'Financial Research', category: 'research', required_atoms: ['core.identity', 'task.research', 'task.financial_analysis'], priority: 85 },
  { id: 'research.environmental', name: 'Environmental Research', category: 'research', required_atoms: ['core.identity', 'task.research'], priority: 80 },
  { id: 'research.educational', name: 'Educational Research', category: 'research', required_atoms: ['core.identity', 'task.research'], priority: 80 },
  { id: 'research.tech_trends', name: 'Tech Trends', category: 'research', required_atoms: ['core.identity', 'task.research'], priority: 85 },
  { id: 'research.patent', name: 'Patent Analysis', category: 'research', required_atoms: ['core.identity', 'task.research', 'task.document_analysis'], priority: 80 },
  { id: 'research.journal', name: 'Journal Analysis', category: 'research', required_atoms: ['core.identity', 'task.research', 'task.document_analysis'], priority: 85 },
  { id: 'summary.executive', name: 'Executive Summary', category: 'summary', required_atoms: ['core.identity', 'task.summary'], priority: 80 },
  { id: 'summary.meeting', name: 'Meeting Summary', category: 'summary', required_atoms: ['core.identity', 'task.summary'], priority: 80 },
  { id: 'summary.book', name: 'Book Summary', category: 'summary', required_atoms: ['core.identity', 'task.summary'], priority: 75 },
  { id: 'summary.article', name: 'Article Summary', category: 'summary', required_atoms: ['core.identity', 'task.summary'], priority: 80 },
  { id: 'extraction.named_entity', name: 'Named Entity', category: 'extraction', required_atoms: ['core.identity', 'task.extraction'], priority: 80 },
  { id: 'extraction.sentiment', name: 'Sentiment', category: 'extraction', required_atoms: ['core.identity', 'task.extraction'], priority: 75 },
  { id: 'extraction.action_items', name: 'Action Items', category: 'extraction', required_atoms: ['core.identity', 'task.extraction', 'task.classification'], priority: 80 },
  { id: 'formatting.md', name: 'Markdown', category: 'formatting', required_atoms: ['core.identity', 'task.formatting'], priority: 70 },
  { id: 'formatting.json', name: 'JSON', category: 'formatting', required_atoms: ['core.identity', 'task.formatting'], priority: 70 },
  { id: 'formatting.html', name: 'HTML', category: 'formatting', required_atoms: ['core.identity', 'task.formatting'], priority: 70 },
  { id: 'formatting.csv', name: 'CSV', category: 'formatting', required_atoms: ['core.identity', 'task.formatting'], priority: 70 },
  { id: 'conversion.unit', name: 'Unit Conversion', category: 'conversion', required_atoms: ['core.identity', 'task.conversion'], priority: 75 },
  { id: 'conversion.format', name: 'Format Conversion', category: 'conversion', required_atoms: ['core.identity', 'task.conversion'], priority: 75 },
  { id: 'conversion.currency', name: 'Currency Conversion', category: 'conversion', required_atoms: ['core.identity', 'task.conversion'], priority: 75 },
  { id: 'conversion.timezone', name: 'Timezone', category: 'conversion', required_atoms: ['core.identity', 'task.conversion'], priority: 75 },
  { id: 'quality.code_review_full', name: 'Full Code Review', category: 'quality', required_atoms: ['core.identity', 'task.code_review'], priority: 85 },
  { id: 'quality.security_scan', name: 'Security Scan', category: 'quality', required_atoms: ['core.identity', 'task.security_audit'], priority: 90 },
  { id: 'quality.accessibility', name: 'Accessibility', category: 'quality', required_atoms: ['core.identity', 'task.quality_control'], priority: 80 },
  { id: 'compliance.check', name: 'Compliance Check', category: 'compliance', required_atoms: ['core.identity', 'task.compliance_check'], priority: 85 },
  { id: 'compliance.data', name: 'Data Protection', category: 'compliance', required_atoms: ['core.identity', 'task.compliance_check', 'core.safety'], priority: 90 },
  { id: 'checklist.project', name: 'Project Checklist', category: 'checklist', required_atoms: ['core.identity', 'task.checklist_generation'], priority: 75 },
  { id: 'checklist.launch', name: 'Launch Checklist', category: 'checklist', required_atoms: ['core.identity', 'task.checklist_generation'], priority: 80 },
  { id: 'checklist.safety', name: 'Safety Checklist', category: 'checklist', required_atoms: ['core.identity', 'task.checklist_generation', 'core.safety'], priority: 85 },
  { id: 'template.business', name: 'Business Template', category: 'template', required_atoms: ['core.identity', 'task.template_generation'], priority: 75 },
  { id: 'template.technical', name: 'Technical Template', category: 'template', required_atoms: ['core.identity', 'task.template_generation'], priority: 75 },
  { id: 'template.legal', name: 'Legal Template', category: 'template', required_atoms: ['core.identity', 'task.template_generation'], priority: 80 },
  { id: 'workflow.automation', name: 'Workflow Automation', category: 'workflow', required_atoms: ['core.identity', 'task.workflow_generation'], priority: 80 },
  { id: 'workflow.pipeline', name: 'Pipeline Design', category: 'workflow', required_atoms: ['core.identity', 'task.workflow_generation'], priority: 80 },
  { id: 'workflow.incident', name: 'Incident Response', category: 'workflow', required_atoms: ['core.identity', 'task.workflow_generation'], priority: 80 },
  { id: 'instruction.tutorial', name: 'Tutorial', category: 'instruction', required_atoms: ['core.identity', 'task.instruction_generation', 'task.tutoring'], priority: 80 },
  { id: 'instruction.troubleshooting', name: 'Troubleshooting Guide', category: 'instruction', required_atoms: ['core.identity', 'task.instruction_generation', 'task.troubleshooting'], priority: 80 },
  { id: 'simulation.physical', name: 'Physical Sim', category: 'simulation', required_atoms: ['core.identity', 'task.simulation'], priority: 80 },
  { id: 'simulation.economic', name: 'Economic Sim', category: 'simulation', required_atoms: ['core.identity', 'task.simulation', 'task.data_analysis'], priority: 80 },
  { id: 'scenario.what_if', name: 'What-If', category: 'scenario', required_atoms: ['core.identity', 'task.scenario_analysis'], priority: 80 },
  { id: 'scenario.stress_test', name: 'Stress Test', category: 'scenario', required_atoms: ['core.identity', 'task.scenario_analysis', 'task.data_analysis'], priority: 80 },
  { id: 'scenario.failure_mode', name: 'Failure Mode', category: 'scenario', required_atoms: ['core.identity', 'task.root_cause_analysis'], priority: 80 },
  { id: 'risk.financial', name: 'Financial Risk', category: 'risk', required_atoms: ['core.identity', 'task.risk_analysis'], priority: 85 },
  { id: 'risk.operational', name: 'Operational Risk', category: 'risk', required_atoms: ['core.identity', 'task.risk_analysis'], priority: 85 },
  { id: 'risk.cyber', name: 'Cyber Risk', category: 'risk', required_atoms: ['core.identity', 'task.risk_analysis', 'task.security_audit'], priority: 90 },
  { id: 'risk.regulatory', name: 'Regulatory Risk', category: 'risk', required_atoms: ['core.identity', 'task.risk_analysis', 'task.compliance_check'], priority: 90 },
  { id: 'impact.environmental', name: 'Environmental Impact', category: 'impact', required_atoms: ['core.identity', 'task.impact_analysis'], priority: 80 },
  { id: 'impact.social', name: 'Social Impact', category: 'impact', required_atoms: ['core.identity', 'task.impact_analysis'], priority: 80 },
  { id: 'impact.economic', name: 'Economic Impact', category: 'impact', required_atoms: ['core.identity', 'task.impact_analysis', 'task.financial_analysis'], priority: 85 },
  { id: 'root_cause.software', name: 'Software Root Cause', category: 'root_cause', required_atoms: ['core.identity', 'task.root_cause_analysis'], priority: 85 },
  { id: 'root_cause.system', name: 'System Root Cause', category: 'root_cause', required_atoms: ['core.identity', 'task.root_cause_analysis'], priority: 85 },
  { id: 'root_cause.business', name: 'Business Root Cause', category: 'root_cause', required_atoms: ['core.identity', 'task.root_cause_analysis'], priority: 80 },
  { id: 'source_fidelity.check', name: 'Source Fidelity', category: 'source_fidelity', required_atoms: ['core.identity', 'task.source_fidelity', 'verification.source'], priority: 90 },
  { id: 'source_fidelity.citation', name: 'Citation Verification', category: 'source_fidelity', required_atoms: ['core.identity', 'task.source_fidelity', 'verification.source'], priority: 90 },
  { id: 'synthesis.multi_source', name: 'Multi-Source Synthesis', category: 'synthesis', required_atoms: ['core.identity', 'task.synthesis', 'research.multi_source'], priority: 85 },
  { id: 'synthesis.cross_domain', name: 'Cross-Domain', category: 'synthesis', required_atoms: ['core.identity', 'task.synthesis'], priority: 80 },
  { id: 'synthesis.timeline', name: 'Timeline Synthesis', category: 'synthesis', required_atoms: ['core.identity', 'task.synthesis'], priority: 80 },
  { id: 'synthesis.comparative', name: 'Comparative Synthesis', category: 'synthesis', required_atoms: ['core.identity', 'task.synthesis', 'task.comparison'], priority: 80 },
];

export async function upsertScenario(input: ScenarioInput): Promise<string> {
  const { tags = [] } = input;
  await prismaKnowledge.scenario.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      name: input.name,
      description: input.description,
      category: input.category || 'general',
      tags: JSON.stringify(tags),
      required_atoms: JSON.stringify(input.required_atoms),
      optional_atoms: JSON.stringify(input.optional_atoms || []),
      exclude_atoms: JSON.stringify(input.exclude_atoms || []),
      max_atoms: input.max_atoms || 12,
      priority: input.priority ?? 50,
      status: input.status || 'published',
    },
    update: {
      name: input.name,
      description: input.description,
      category: input.category || undefined,
      tags: JSON.stringify(tags),
      required_atoms: JSON.stringify(input.required_atoms),
      optional_atoms: input.optional_atoms ? JSON.stringify(input.optional_atoms) : undefined,
      exclude_atoms: input.exclude_atoms ? JSON.stringify(input.exclude_atoms) : undefined,
      max_atoms: input.max_atoms || undefined,
      priority: input.priority !== undefined ? input.priority : undefined,
      status: input.status || undefined,
    },
  });
  return input.id;
}

export async function seedDefaultScenarios(): Promise<void> {
  const existing = await prismaKnowledge.scenario.count();
  if (existing > 0) return;
  for (const s of DEFAULT_SCENARIOS) {
    try {
      await upsertScenario(s);
    } catch {}
  }
}

export async function getScenario(id: string): Promise<any | null> {
  return prismaKnowledge.scenario.findUnique({ where: { id } });
}

export async function getPublishedScenarios(category?: string): Promise<any[]> {
  const where: any = { status: 'published' };
  if (category) where.category = category;
  return prismaKnowledge.scenario.findMany({ where, orderBy: { priority: 'desc' } });
}

export async function getAllScenarios(): Promise<any[]> {
  return prismaKnowledge.scenario.findMany({ orderBy: { priority: 'desc' } });
}

export async function setScenarioStatus(id: string, status: string): Promise<void> {
  await prismaKnowledge.scenario.update({ where: { id }, data: { status } });
}
