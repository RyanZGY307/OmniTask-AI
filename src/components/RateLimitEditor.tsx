import { useState } from 'react';

export type RateLimitBlock = {
  rpm?: string; tpm?: string; rpd?: string;
  maxParallel?: string; tpd?: string;
  tpdLimitRpm?: string;
  tpdBehavior?: 'block' | 'limitRpm';
};

