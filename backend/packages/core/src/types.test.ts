/**
 * Tests for @cast/core types and utilities
 */
import { describe, it, expect } from 'vitest';
import {
  // MIME utilities
  ASSET_MIME_TYPES,
  getMimeType,
  isSupportedAssetType,
  // Artifact utilities
  isArtifactType,
  isArtifactStatus,
  getDefaultArtifactStatus,
  slugToPathSegment,
  pathSegmentToSlug,
  extractRefs,
  // Type guards
  isStoredMessage,
  isStoredChannel,
  isRosterEntry,
  isStoredArtifact,
} from './types.js';

// =============================================================================
// MIME Type Utilities (Phase E)
// =============================================================================

describe('MIME Type Utilities', () => {
  describe('ASSET_MIME_TYPES', () => {
    it('contains expected image types', () => {
      expect(ASSET_MIME_TYPES['.png']).toBe('image/png');
      expect(ASSET_MIME_TYPES['.jpg']).toBe('image/jpeg');
      expect(ASSET_MIME_TYPES['.jpeg']).toBe('image/jpeg');
      expect(ASSET_MIME_TYPES['.gif']).toBe('image/gif');
      expect(ASSET_MIME_TYPES['.webp']).toBe('image/webp');
      expect(ASSET_MIME_TYPES['.svg']).toBe('image/svg+xml');
      expect(ASSET_MIME_TYPES['.ico']).toBe('image/x-icon');
    });

    it('contains expected audio types', () => {
      expect(ASSET_MIME_TYPES['.mp3']).toBe('audio/mpeg');
      expect(ASSET_MIME_TYPES['.wav']).toBe('audio/wav');
      expect(ASSET_MIME_TYPES['.ogg']).toBe('audio/ogg');
    });

    it('contains expected video types', () => {
      expect(ASSET_MIME_TYPES['.mp4']).toBe('video/mp4');
      expect(ASSET_MIME_TYPES['.webm']).toBe('video/webm');
    });

    it('contains expected document types', () => {
      expect(ASSET_MIME_TYPES['.pdf']).toBe('application/pdf');
      expect(ASSET_MIME_TYPES['.json']).toBe('application/json');
    });

    it('contains expected font types', () => {
      expect(ASSET_MIME_TYPES['.woff']).toBe('font/woff');
      expect(ASSET_MIME_TYPES['.woff2']).toBe('font/woff2');
      expect(ASSET_MIME_TYPES['.ttf']).toBe('font/ttf');
    });

    it('contains expected other types', () => {
      expect(ASSET_MIME_TYPES['.zip']).toBe('application/zip');
      expect(ASSET_MIME_TYPES['.wasm']).toBe('application/wasm');
    });
  });

  describe('getMimeType', () => {
    it('returns correct MIME type for known extensions', () => {
      expect(getMimeType('image.png')).toBe('image/png');
      expect(getMimeType('photo.jpg')).toBe('image/jpeg');
      expect(getMimeType('document.pdf')).toBe('application/pdf');
      expect(getMimeType('video.mp4')).toBe('video/mp4');
      expect(getMimeType('data.json')).toBe('application/json');
    });

    it('handles uppercase extensions by lowercasing', () => {
      expect(getMimeType('image.PNG')).toBe('image/png');
      expect(getMimeType('photo.JPG')).toBe('image/jpeg');
      expect(getMimeType('VIDEO.MP4')).toBe('video/mp4');
    });

    it('returns application/octet-stream for unknown extensions', () => {
      expect(getMimeType('file.xyz')).toBe('application/octet-stream');
      expect(getMimeType('data.unknown')).toBe('application/octet-stream');
      expect(getMimeType('random.abc123')).toBe('application/octet-stream');
    });

    it('returns application/octet-stream for files without extensions', () => {
      expect(getMimeType('noextension')).toBe('application/octet-stream');
      expect(getMimeType('file')).toBe('application/octet-stream');
    });

    it('handles files with multiple dots correctly', () => {
      expect(getMimeType('my.file.png')).toBe('image/png');
      expect(getMimeType('backup.2024.01.05.pdf')).toBe('application/pdf');
      expect(getMimeType('some.thing.else.jpg')).toBe('image/jpeg');
    });

    it('works with slug-style filenames', () => {
      expect(getMimeType('my-cool-image.png')).toBe('image/png');
      expect(getMimeType('screenshot-2024.webp')).toBe('image/webp');
      expect(getMimeType('diagram-v2.svg')).toBe('image/svg+xml');
    });
  });

  describe('isSupportedAssetType', () => {
    it('returns true for supported image types', () => {
      expect(isSupportedAssetType('image.png')).toBe(true);
      expect(isSupportedAssetType('photo.jpg')).toBe(true);
      expect(isSupportedAssetType('animation.gif')).toBe(true);
      expect(isSupportedAssetType('icon.svg')).toBe(true);
    });

    it('returns true for supported audio/video types', () => {
      expect(isSupportedAssetType('song.mp3')).toBe(true);
      expect(isSupportedAssetType('video.mp4')).toBe(true);
      expect(isSupportedAssetType('audio.wav')).toBe(true);
    });

    it('returns true for supported document types', () => {
      expect(isSupportedAssetType('doc.pdf')).toBe(true);
      expect(isSupportedAssetType('data.json')).toBe(true);
    });

    it('returns true for text types added in Phase F', () => {
      expect(isSupportedAssetType('file.txt')).toBe(true);
      expect(isSupportedAssetType('script.js')).toBe(true);
      expect(isSupportedAssetType('readme.md')).toBe(true);
      expect(isSupportedAssetType('styles.css')).toBe(true);
    });

    it('returns false for unsupported types', () => {
      expect(isSupportedAssetType('doc.docx')).toBe(false);
      expect(isSupportedAssetType('image.bmp')).toBe(false);
      expect(isSupportedAssetType('file.exe')).toBe(false);
    });

    it('returns false for files without extensions', () => {
      expect(isSupportedAssetType('noextension')).toBe(false);
      expect(isSupportedAssetType('README')).toBe(false);
    });

    it('handles uppercase extensions by lowercasing', () => {
      expect(isSupportedAssetType('image.PNG')).toBe(true);
      expect(isSupportedAssetType('photo.JPG')).toBe(true);
    });
  });
});

// =============================================================================
// Artifact Type Guards and Utilities
// =============================================================================

describe('Artifact Type Utilities', () => {
  describe('isArtifactType', () => {
    it('returns true for valid artifact types', () => {
      expect(isArtifactType('doc')).toBe(true);
      expect(isArtifactType('task')).toBe(true);
      expect(isArtifactType('code')).toBe(true);
      expect(isArtifactType('decision')).toBe(true);
      expect(isArtifactType('knowledgebase')).toBe(true);
      expect(isArtifactType('asset')).toBe(true);
    });

    it('returns true for system artifact types', () => {
      expect(isArtifactType('system.mcp')).toBe(true);
      expect(isArtifactType('system.agent')).toBe(true);
      expect(isArtifactType('system.focus')).toBe(true);
      expect(isArtifactType('system.playbook')).toBe(true);
    });

    it('returns false for invalid types', () => {
      expect(isArtifactType('invalid')).toBe(false);
      expect(isArtifactType('document')).toBe(false);
      expect(isArtifactType('')).toBe(false);
      expect(isArtifactType(null)).toBe(false);
      expect(isArtifactType(undefined)).toBe(false);
      expect(isArtifactType(123)).toBe(false);
    });
  });

  describe('isArtifactStatus', () => {
    it('returns true for valid statuses', () => {
      expect(isArtifactStatus('draft')).toBe(true);
      expect(isArtifactStatus('active')).toBe(true);
      expect(isArtifactStatus('archived')).toBe(true);
      expect(isArtifactStatus('pending')).toBe(true);
      expect(isArtifactStatus('in_progress')).toBe(true);
      expect(isArtifactStatus('done')).toBe(true);
      expect(isArtifactStatus('blocked')).toBe(true);
    });

    it('returns true for legacy published status', () => {
      // 'published' is legacy but still valid for backwards compatibility
      expect(isArtifactStatus('published')).toBe(true);
    });

    it('returns false for invalid statuses', () => {
      expect(isArtifactStatus('invalid')).toBe(false);
      expect(isArtifactStatus('completed')).toBe(false);
      expect(isArtifactStatus('')).toBe(false);
      expect(isArtifactStatus(null)).toBe(false);
    });
  });

  describe('getDefaultArtifactStatus', () => {
    it('returns pending for task type', () => {
      expect(getDefaultArtifactStatus('task')).toBe('pending');
      expect(getDefaultArtifactStatus('task', 'user')).toBe('pending');
    });

    it('returns active for system types', () => {
      expect(getDefaultArtifactStatus('system.mcp')).toBe('active');
      expect(getDefaultArtifactStatus('system.agent')).toBe('active');
      expect(getDefaultArtifactStatus('system.focus')).toBe('active');
      expect(getDefaultArtifactStatus('system.playbook')).toBe('active');
    });

    it('returns active for human-created docs', () => {
      expect(getDefaultArtifactStatus('doc', 'user')).toBe('active');
      expect(getDefaultArtifactStatus('code', 'user')).toBe('active');
      expect(getDefaultArtifactStatus('decision', 'user')).toBe('active');
    });

    it('returns draft for agent-created docs', () => {
      expect(getDefaultArtifactStatus('doc')).toBe('draft');
      expect(getDefaultArtifactStatus('doc', 'fox')).toBe('draft');
      expect(getDefaultArtifactStatus('code', 'builder-agent')).toBe('draft');
      expect(getDefaultArtifactStatus('decision', 'researcher')).toBe('draft');
    });
  });

  describe('slugToPathSegment', () => {
    it('converts hyphens to underscores', () => {
      expect(slugToPathSegment('my-slug')).toBe('my_slug');
      expect(slugToPathSegment('auth-api-spec')).toBe('auth_api_spec');
    });

    it('converts dots to underscores', () => {
      expect(slugToPathSegment('file.ts')).toBe('file_ts');
      expect(slugToPathSegment('config.schema.json')).toBe('config_schema_json');
    });

    it('handles mixed separators', () => {
      expect(slugToPathSegment('my-file.txt')).toBe('my_file_txt');
    });

    it('handles slugs without separators', () => {
      expect(slugToPathSegment('simple')).toBe('simple');
    });
  });

  describe('pathSegmentToSlug', () => {
    it('converts underscores to hyphens', () => {
      expect(pathSegmentToSlug('my_slug')).toBe('my-slug');
      expect(pathSegmentToSlug('auth_api_spec')).toBe('auth-api-spec');
    });

    it('handles segments without underscores', () => {
      expect(pathSegmentToSlug('simple')).toBe('simple');
    });
  });

  describe('extractRefs', () => {
    it('extracts single reference', () => {
      const refs = extractRefs('See [[my-doc]] for details.');
      expect(refs).toEqual(['my-doc']);
    });

    it('extracts multiple references', () => {
      const refs = extractRefs('Check [[doc-a]] and [[doc-b]] for context.');
      expect(refs).toEqual(['doc-a', 'doc-b']);
    });

    it('extracts references with dots', () => {
      const refs = extractRefs('See [[config.json]] for settings.');
      expect(refs).toEqual(['config.json']);
    });

    it('deduplicates references', () => {
      const refs = extractRefs('First [[my-doc]], then [[other]], then [[my-doc]] again.');
      expect(refs).toEqual(['my-doc', 'other']);
    });

    it('returns empty array when no references', () => {
      const refs = extractRefs('No references here.');
      expect(refs).toEqual([]);
    });

    it('handles empty content', () => {
      const refs = extractRefs('');
      expect(refs).toEqual([]);
    });

    it('ignores malformed references', () => {
      const refs = extractRefs('Invalid [my-doc] and [[]] and [[My Doc]]');
      expect(refs).toEqual([]);
    });
  });
});

// =============================================================================
// Type Guards
// =============================================================================

describe('Type Guards', () => {
  describe('isStoredMessage', () => {
    it('returns true for valid message objects', () => {
      const message = {
        id: '01ABC',
        channelId: 'chan-1',
        sender: 'user1',
        spaceId: 'space-1',
        senderType: 'user',
        type: 'user',
        content: 'hello',
        timestamp: new Date().toISOString(),
        isComplete: true,
      };
      expect(isStoredMessage(message)).toBe(true);
    });

    it('returns false for objects missing required fields', () => {
      expect(isStoredMessage({ id: '01ABC', channelId: 'chan-1' })).toBe(false);
      expect(isStoredMessage({ id: '01ABC', sender: 'user1' })).toBe(false);
      expect(isStoredMessage({ channelId: 'chan-1', sender: 'user1' })).toBe(false);
    });

    it('returns false for non-objects', () => {
      expect(isStoredMessage(null)).toBe(false);
      expect(isStoredMessage(undefined)).toBe(false);
      expect(isStoredMessage('string')).toBe(false);
      expect(isStoredMessage(123)).toBe(false);
    });
  });

  describe('isStoredChannel', () => {
    it('returns true for valid channel objects', () => {
      const channel = {
        id: '01ABC',
        spaceId: 'space-1',
        name: 'general',
        archived: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(isStoredChannel(channel)).toBe(true);
    });

    it('returns false for objects missing required fields', () => {
      expect(isStoredChannel({ id: '01ABC', spaceId: 'space-1' })).toBe(false);
      expect(isStoredChannel({ id: '01ABC', name: 'general' })).toBe(false);
    });

    it('returns false for non-objects', () => {
      expect(isStoredChannel(null)).toBe(false);
      expect(isStoredChannel(undefined)).toBe(false);
    });
  });

  describe('isRosterEntry', () => {
    it('returns true for valid roster entry objects', () => {
      const entry = {
        id: '01ABC',
        channelId: 'chan-1',
        callsign: 'fox',
        agentType: 'engineer',
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      expect(isRosterEntry(entry)).toBe(true);
    });

    it('returns false for objects missing required fields', () => {
      expect(isRosterEntry({ id: '01ABC', channelId: 'chan-1' })).toBe(false);
      expect(isRosterEntry({ id: '01ABC', callsign: 'fox' })).toBe(false);
    });

    it('returns false for non-objects', () => {
      expect(isRosterEntry(null)).toBe(false);
      expect(isRosterEntry(undefined)).toBe(false);
    });
  });

  describe('isStoredArtifact', () => {
    it('returns true for valid artifact objects', () => {
      const artifact = {
        id: '01ABC',
        channelId: 'chan-1',
        slug: 'my-doc',
        type: 'doc',
        content: '# Hello',
        path: 'my_doc',
        orderKey: '0',
        status: 'draft',
        assignees: [],
        labels: [],
        refs: [],
        version: 1,
        createdBy: 'user1',
        createdAt: new Date().toISOString(),
      };
      expect(isStoredArtifact(artifact)).toBe(true);
    });

    it('returns false for objects missing required fields', () => {
      expect(isStoredArtifact({ id: '01ABC', channelId: 'chan-1' })).toBe(false);
      expect(isStoredArtifact({ id: '01ABC', slug: 'my-doc' })).toBe(false);
      expect(isStoredArtifact({ id: '01ABC', channelId: 'chan-1', slug: 'my-doc' })).toBe(false);
    });

    it('returns false for non-objects', () => {
      expect(isStoredArtifact(null)).toBe(false);
      expect(isStoredArtifact(undefined)).toBe(false);
      expect(isStoredArtifact('string')).toBe(false);
    });
  });
});
