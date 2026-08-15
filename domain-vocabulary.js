'use strict';

const DOMAINS = {
  Boomi: {
    // 1. Sent to Deepgram to prevent mishearing jargon
    stt_keyterms: [
      'Boomi', 'OAuth', 'Atom', 'Molecule', 'SFTP', 'SAP', 'Salesforce',
      'Process Property', 'Dynamic Process Property', 'Process Route',
      'Environment Extensions', 'Flat File', 'Profile', 'JVM', 'Heap',
      'Integration', 'API Management', 'EDI', 'AS2', 'Flow Control'
    ],
    // 2. Used by the Engine to know a question is grammatically incomplete
    incomplete_hooks: [
      'between', 'into', 'from', 'across', 'using', 'through',
      'during', 'via', 'with', 'for', 'about', 'and', 'or', 'to', 'of', 'in', 'on'
    ],
    // 3. Injected into Groq prompt for grounding
    knowledge_base: 'Focus on Boomi integration: Atoms, Molecules, Cloud Hubs, Connectors, Try/Catch error handling, listener processes, process properties, document/record batching, parallel processing, and error isolation.'
  }
};

function getDomainConfig(domainName) {
  return DOMAINS[domainName] || DOMAINS.Boomi;
}

module.exports = { DOMAINS, getDomainConfig };