// ================================================================
// Political Safety — Neutral Information Mode
// ================================================================
// When political content is detected, enforce Neutral Information Mode:
// - Allow: factual comparisons, policy differences, public records,
//   source analysis, historical results, poll data
// - Prohibit: political recommendations, rankings, voting advice,
//   outcome predictions, voting tendency inference
// ================================================================

export interface PoliticalCheckResult {
  isPolitical: boolean;
  neutralMode: boolean;
  topics: string[];
  instructions: string[];
}

const POLITICAL_TRIGGERS: Array<{ pattern: RegExp; topic: string }> = [
  { pattern: /election|elections|electoral/i, topic: 'elections' },
  { pattern: /candidate|candidates|president|prime minister|governor|mayor/i, topic: 'candidates' },
  { pattern: /party|parties|congress|parliament|senate|house of representatives/i, topic: 'parties' },
  { pattern: /vot(e|ing)|ballot|referendum/i, topic: 'voting' },
  { pattern: /policy|policies|legislation|bill|bills|act|acts|amendment/i, topic: 'policy' },
  { pattern: /government|state|federal|local|national (government|policy|administration)/i, topic: 'government' },
  { pattern: /political|politics|politician|politicians/i, topic: 'politics' },
  { pattern: /campaign|campaigns|platform|manifesto/i, topic: 'campaigns' },
  { pattern: /poll|polls|polling|opinion poll|approval rating/i, topic: 'polls' },
  { pattern: /impeach|impeachment|censure|sanction/i, topic: 'accountability' },
  { pattern: /constitution|constitutional|supreme court|judicial/i, topic: 'judicial' },
  { pattern: /lobby|lobbying|interest group|think tank/i, topic: 'lobbying' },
  { pattern: /diplomatic|diplomacy|treaty|sanctions|trade war/i, topic: 'international' },
];

const NEUTRAL_INSTRUCTIONS = [
  'Present factual information about political topics without endorsing any party, candidate, or position.',
  'You may compare policies, analyze public records, cite official sources, and present historical election results.',
  'You may present polling data and survey results with their methodology and caveats.',
  'You must NOT make political recommendations, rank candidates, predict election outcomes, or infer voting tendencies.',
  'You must NOT express personal political opinions or advocate for any party or candidate.',
  'When presenting multiple perspectives, give each fair representation without implying one is correct.',
  'For controversial topics, present the range of views and the factual basis for each.',
  'Distinguish clearly between established facts, reported claims, and opinion.',
  'If asked for a prediction or recommendation, state that you do not make political predictions or recommendations, then provide relevant factual context.',
];

export function checkPoliticalContent(message: string): PoliticalCheckResult {
  const topics: string[] = [];
  let isPolitical = false;

  for (const { pattern, topic } of POLITICAL_TRIGGERS) {
    if (pattern.test(message)) {
      topics.push(topic);
      isPolitical = true;
    }
  }

  if (topics.length === 0) {
    return { isPolitical: false, neutralMode: false, topics: [], instructions: [] };
  }

  return {
    isPolitical: true,
    neutralMode: true,
    topics: [...new Set(topics)],
    instructions: NEUTRAL_INSTRUCTIONS,
  };
}

export function buildPoliticalSection(check: PoliticalCheckResult): string {
  if (!check.neutralMode) return '';

  const lines = [
    '[POLITICAL NEUTRALITY]',
    `Detected political topics: ${check.topics.join(', ')}`,
    '',
    ...check.instructions,
  ];
  return lines.join('\n');
}
