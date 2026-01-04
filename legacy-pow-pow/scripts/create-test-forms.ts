import { store } from '../src/server/store.js';

// Test form 1: Single agent
store.addStructuredAsk('cast-structured-asks', 'bravo', {
  prompt: 'Test 1: Single agent proposal',
  fields: [{
    id: 'team',
    type: 'summon_request',
    label: 'Proposed agent',
    description: 'Single specialist for focused task',
    agents: [
      { callsign: 'delta', definitionSlug: 'engineer', purpose: 'Database optimization' }
    ]
  }],
  to: []
});

// Test form 2: Multiple agents
store.addStructuredAsk('cast-structured-asks', 'bravo', {
  prompt: 'Test 2: Multiple agents proposal',
  fields: [{
    id: 'team',
    type: 'summon_request',
    label: 'Proposed team',
    description: 'Full team for the project',
    agents: [
      { callsign: 'echo', definitionSlug: 'engineer', purpose: 'Frontend components' },
      { callsign: 'foxtrot', definitionSlug: 'engineer', purpose: 'Backend API' },
      { callsign: 'golf', definitionSlug: 'engineer', purpose: 'Testing & QA' }
    ]
  }],
  to: []
});

// Test form 3: Mixed fields
store.addStructuredAsk('cast-structured-asks', 'bravo', {
  prompt: 'Test 3: Mixed fields (radio + summon_request)',
  fields: [
    {
      id: 'priority',
      type: 'radio',
      label: 'Priority level',
      options: [
        { value: 'high', label: 'High - urgent' },
        { value: 'medium', label: 'Medium - normal' },
        { value: 'low', label: 'Low - when available' }
      ]
    },
    {
      id: 'team',
      type: 'summon_request',
      label: 'Proposed agents',
      description: 'Specialists for this task',
      agents: [
        { callsign: 'hotel', definitionSlug: 'engineer', purpose: 'Implementation' },
        { callsign: 'india', definitionSlug: 'engineer', purpose: 'Code review' }
      ]
    }
  ],
  to: []
});

console.log('Created 3 test forms');
