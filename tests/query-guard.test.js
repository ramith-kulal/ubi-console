/**
 * query-guard.test.js — the boundary between a developer's typing and a table
 * holding Aadhaar, PAN, KCC and credit data. Tested before anything trusts it.
 */

import { describe, it, expect } from './harness.js';
import {
  analyzeQuery,
  statementBadge,
  DEFAULT_ROW_LIMIT,
  CHANNEL_QUERY,
  CHANNEL_TABLE_DDL,
  CHANNEL_ADMIN_DDL,
  RISK_READ,
  RISK_WRITE,
  RISK_DESTRUCTIVE,
} from '../lib/query-guard.js';

describe('query-guard: statement classification (all types permitted)', () => {
  it('classifies the DML statements', () => {
    expect(analyzeQuery('SELECT * FROM CUSTID_DETAILS').type).toBe('SELECT');
    expect(analyzeQuery("UPDATE CUSTID_DETAILS SET state='KA' WHERE id='1'").type).toBe('UPDATE');
    expect(analyzeQuery("DELETE FROM CUSTID_DETAILS WHERE id='1'").type).toBe('DELETE');
    expect(analyzeQuery("INSERT INTO CUSTID_DETAILS VALUES('a')").type).toBe('INSERT');
    expect(analyzeQuery("UPSERT INTO CUSTID_DETAILS VALUES('a')").type).toBe('UPSERT');
  });

  it('permits DDL and routes it to tableDDL, not query()', () => {
    // Oracle NoSQL will not accept these through query(); misrouting them means
    // they simply fail, so the channel is functional, not cosmetic.
    const tableDdl = [
      'DROP TABLE CUSTID_DETAILS',
      'CREATE TABLE X (id STRING, PRIMARY KEY(id))',
      'ALTER TABLE CUSTID_DETAILS (ADD foo STRING)',
      'TRUNCATE TABLE CUSTID_DETAILS',
      'CREATE INDEX idx ON CUSTID_DETAILS(custId)',
      'DROP INDEX idx ON CUSTID_DETAILS',
    ];
    for (const sql of tableDdl) {
      const v = analyzeQuery(sql);
      expect(v.ok).toBeTruthy();
      expect(v.channel).toBe(CHANNEL_TABLE_DDL);
      expect(v.risk).toBe(RISK_DESTRUCTIVE);
    }
  });

  it('routes security and namespace statements to adminDDL', () => {
    for (const sql of [
      'GRANT ALL ON CUSTID_DETAILS TO PUBLIC',
      'REVOKE SELECT ON CUSTID_DETAILS FROM x',
      'CREATE NAMESPACE ops',
      'DROP NAMESPACE ops',
      'CREATE USER bob IDENTIFIED BY "x"',
      'DROP ROLE auditor',
    ]) {
      const v = analyzeQuery(sql);
      expect(v.ok).toBeTruthy();
      expect(v.channel).toBe(CHANNEL_ADMIN_DDL);
    }
  });

  it('routes DML to query()', () => {
    expect(analyzeQuery('SELECT * FROM T').channel).toBe(CHANNEL_QUERY);
    expect(analyzeQuery("DELETE FROM T WHERE id='1'").channel).toBe(CHANNEL_QUERY);
  });

  it('assigns risk tiers that drive the confirmation the UI demands', () => {
    expect(analyzeQuery('SELECT * FROM T').risk).toBe(RISK_READ);
    expect(analyzeQuery("DELETE FROM T WHERE id='1'").risk).toBe(RISK_WRITE);
    expect(analyzeQuery('DROP TABLE T').risk).toBe(RISK_DESTRUCTIVE);
  });

  it('still refuses an empty editor', () => {
    expect(analyzeQuery('   ').blocked).toBeTruthy();
    expect(analyzeQuery('').blocked).toBeTruthy();
  });

  it('passes an unrecognised keyword through and lets the database judge it', () => {
    // Refusing unknown keywords would block valid dialect syntax we have not
    // enumerated. The DB is the authority on its own grammar.
    const v = analyzeQuery('FROBNICATE THE DATABASE');
    expect(v.ok).toBeTruthy();
    expect(v.requiresConfirmation).toBeTruthy();
  });

  it('is case-insensitive about the statement keyword', () => {
    expect(analyzeQuery('select * from CLOGINS_NEW').type).toBe('SELECT');
    expect(analyzeQuery('DrOp TaBlE x').risk).toBe(RISK_DESTRUCTIVE);
  });
});

describe('query-guard: DDL requires typed confirmation', () => {
  it('demands the table name be typed for DROP TABLE', () => {
    const v = analyzeQuery('DROP TABLE CUSTID_DETAILS');
    expect(v.requiresConfirmation).toBeTruthy();
    expect(v.requiresTypedConfirmation).toBeTruthy();
    expect(v.typedConfirmationValue).toBe('CUSTID_DETAILS');
  });

  it('says plainly that it cannot be previewed or undone', () => {
    const v = analyzeQuery('DROP TABLE APPLICANT');
    expect(v.previewSql).toBeNull();
    expect(v.previewNote).toContain('cannot be undone');
  });

  it('extracts the object name across DDL shapes', () => {
    expect(analyzeQuery('DROP TABLE IF EXISTS T1').typedConfirmationValue).toBe('T1');
    expect(analyzeQuery('TRUNCATE TABLE T2').typedConfirmationValue).toBe('T2');
    expect(analyzeQuery('ALTER TABLE T3 (ADD c STRING)').typedConfirmationValue).toBe('T3');
    expect(analyzeQuery('CREATE TABLE IF NOT EXISTS T4 (id STRING)').typedConfirmationValue).toBe(
      'T4'
    );
    expect(analyzeQuery('DROP INDEX idx ON T5').typedConfirmationValue).toBe('T5');
    expect(analyzeQuery('CREATE INDEX idx ON T6(a)').typedConfirmationValue).toBe('T6');
  });

  it('falls back to the statement type when no object name is readable', () => {
    const v = analyzeQuery('GRANT ALL ON SOMETHING TO PUBLIC');
    expect(v.requiresTypedConfirmation).toBeTruthy();
    expect(v.typedConfirmationValue).toBe('GRANT');
  });

  it('does not demand typed confirmation for ordinary DML', () => {
    expect(analyzeQuery("DELETE FROM T WHERE id='1'").requiresTypedConfirmation).toBeFalsy();
    expect(analyzeQuery('SELECT * FROM T').requiresTypedConfirmation).toBeFalsy();
  });
});

describe('query-guard: INSERT / UPSERT', () => {
  it('requires confirmation and states that no preview is possible', () => {
    const v = analyzeQuery("INSERT INTO CUSTID_DETAILS(custId) VALUES('UBI1')");
    expect(v.ok).toBeTruthy();
    expect(v.table).toBe('CUSTID_DETAILS');
    expect(v.requiresConfirmation).toBeTruthy();
    expect(v.previewSql).toBeNull();
    expect(v.previewNote).toContain('do not exist yet');
  });

  it('does not require a WHERE clause', () => {
    expect(analyzeQuery("INSERT INTO T VALUES('a')").blocked).toBeFalsy();
  });
});

describe('query-guard: multiple statements', () => {
  it('strips a single trailing semicolon', () => {
    const v = analyzeQuery('SELECT * FROM CUSTID_DETAILS;');
    expect(v.ok).toBeTruthy();
    expect(v.normalized).toBe('SELECT * FROM CUSTID_DETAILS');
  });

  it('rejects two statements', () => {
    const v = analyzeQuery("SELECT * FROM CUSTID_DETAILS; DROP TABLE CUSTID_DETAILS");
    expect(v.blocked).toBeTruthy();
    expect(v.code).toBe('MULTIPLE_STATEMENTS');
  });

  it('rejects a piggybacked DELETE after a SELECT', () => {
    const v = analyzeQuery("SELECT 1 FROM T; DELETE FROM CUSTID_DETAILS WHERE id='x'");
    expect(v.code).toBe('MULTIPLE_STATEMENTS');
  });

  it('allows a semicolon inside a string literal', () => {
    // Not a statement break — it is data.
    const v = analyzeQuery("SELECT * FROM CUSTID_DETAILS WHERE custId='a;b'");
    expect(v.ok).toBeTruthy();
  });

  it('rejects trailing content after a semicolon even if only a comment-ish token', () => {
    expect(analyzeQuery('SELECT * FROM T; x').code).toBe('MULTIPLE_STATEMENTS');
  });
});

describe('query-guard: comments', () => {
  it('rejects a line comment', () => {
    const v = analyzeQuery('SELECT * FROM CUSTID_DETAILS -- all of them');
    expect(v.blocked).toBeTruthy();
    expect(v.code).toBe('COMMENT_NOT_ALLOWED');
  });

  it('rejects a block comment', () => {
    expect(analyzeQuery('SELECT /* sneaky */ * FROM T').code).toBe('COMMENT_NOT_ALLOWED');
  });

  it('rejects a comment used to smuggle a WHERE-less delete', () => {
    // The classic: comment out the WHERE so it reads as harmless.
    const v = analyzeQuery("DELETE FROM CUSTID_DETAILS -- WHERE id='1'");
    expect(v.blocked).toBeTruthy();
  });

  it('does NOT treat -- inside a string literal as a comment', () => {
    // This is a legitimate query; the dashes are data.
    const v = analyzeQuery("SELECT * FROM CUSTID_DETAILS WHERE custId='a--b'");
    expect(v.ok).toBeTruthy();
    expect(v.type).toBe('SELECT');
  });

  it('does NOT treat /* inside a string literal as a comment', () => {
    const v = analyzeQuery("SELECT * FROM T WHERE note='/* not a comment */'");
    expect(v.ok).toBeTruthy();
  });

  it('handles an apostrophe inside a block comment without desyncing quotes', () => {
    // The exact case the rejection exists for: if this were allowed through,
    // quote tracking after it would be inverted and the preview could describe
    // different rows than the statement touches.
    const v = analyzeQuery("DELETE FROM T /* it's fine */ WHERE id='1'");
    expect(v.blocked).toBeTruthy();
    expect(v.code).toBe('COMMENT_NOT_ALLOWED');
  });
});

describe('query-guard: SELECT limits', () => {
  it('appends LIMIT 500 when absent', () => {
    const v = analyzeQuery('SELECT * FROM APPLICANT');
    expect(v.limitApplied).toBeTruthy();
    expect(v.effectiveLimit).toBe(DEFAULT_ROW_LIMIT);
    expect(v.executable).toBe('SELECT * FROM APPLICANT LIMIT 500');
  });

  it('respects an existing top-level LIMIT', () => {
    const v = analyzeQuery('SELECT * FROM APPLICANT LIMIT 10');
    expect(v.limitApplied).toBeFalsy();
    expect(v.executable).toBe('SELECT * FROM APPLICANT LIMIT 10');
  });

  it('does not mistake the word LIMIT inside a string for a clause', () => {
    const v = analyzeQuery("SELECT * FROM T WHERE note='no LIMIT here'");
    expect(v.limitApplied).toBeTruthy();
    expect(v.executable).toContain('LIMIT 500');
  });

  it('handles a nested-table SELECT (no JOIN in this dialect)', () => {
    const sql =
      'SELECT * FROM NESTED TABLES (ZONES Z descendants(ZONES.ROS ZR, ZONES.ROS.BRANCHES ZRB))' +
      " WHERE ZRB.branch_code='123'";
    const v = analyzeQuery(sql);
    expect(v.ok).toBeTruthy();
    expect(v.type).toBe('SELECT');
  });
});

describe('query-guard: DELETE shape', () => {
  it('extracts table and WHERE', () => {
    const v = analyzeQuery("DELETE FROM CUSTID_DETAILS WHERE custId='UBI123'");
    expect(v.ok).toBeTruthy();
    expect(v.table).toBe('CUSTID_DETAILS');
    expect(v.where).toBe("custId='UBI123'");
    expect(v.requiresConfirmation).toBeTruthy();
    expect(v.previewSql).toBe(
      "SELECT * FROM CUSTID_DETAILS WHERE custId='UBI123' LIMIT 501"
    );
  });

  it('handles an alias', () => {
    const v = analyzeQuery("DELETE FROM CUSTID_DETAILS CD WHERE CD.custId='x'");
    expect(v.table).toBe('CUSTID_DETAILS');
    expect(v.alias).toBe('CD');
    expect(v.previewSql).toBe("SELECT * FROM CUSTID_DETAILS CD WHERE CD.custId='x' LIMIT 501");
  });

  it('handles an AS alias', () => {
    const v = analyzeQuery("DELETE FROM CUSTID_DETAILS AS CD WHERE CD.id='x'");
    expect(v.table).toBe('CUSTID_DETAILS');
    expect(v.alias).toBe('CD');
  });

  it('handles a nested table name', () => {
    const v = analyzeQuery("DELETE FROM APPLICANT.LOANDATAS WHERE id='x'");
    expect(v.table).toBe('APPLICANT.LOANDATAS');
  });

  it('HARD REJECTS a DELETE with no WHERE — no preview, no confirm path', () => {
    const v = analyzeQuery('DELETE FROM CUSTID_DETAILS');
    expect(v.blocked).toBeTruthy();
    expect(v.code).toBe('NO_WHERE');
    expect(v.requiresConfirmation).toBeFalsy();
    expect(v.previewSql).toBe(undefined);
    expect(v.reason).toContain('every row');
  });

  it('rejects DELETE with no WHERE even with a LIMIT attached', () => {
    expect(analyzeQuery('DELETE FROM CUSTID_DETAILS LIMIT 1').code).toBe('NO_WHERE');
  });

  it('is not fooled by the word WHERE inside a string literal', () => {
    // There is no real WHERE clause here — only the text "WHERE" as data.
    const v = analyzeQuery("DELETE FROM T");
    expect(v.code).toBe('NO_WHERE');
    const v2 = analyzeQuery("DELETE FROM T WHERE note='WHERE'");
    expect(v2.ok).toBeTruthy();
    expect(v2.where).toBe("note='WHERE'");
  });

  it('rejects a DELETE with no FROM', () => {
    expect(analyzeQuery("DELETE CUSTID_DETAILS WHERE id='1'").code).toBe('NO_FROM');
  });

  it('terminates the WHERE clause at a top-level RETURNING', () => {
    const v = analyzeQuery("DELETE FROM T WHERE id='1' RETURNING id");
    expect(v.where).toBe("id='1'");
    expect(v.previewSql).toBe("SELECT * FROM T WHERE id='1' LIMIT 501");
  });
});

describe('query-guard: UPDATE shape', () => {
  it('extracts the WHERE that comes after SET', () => {
    const v = analyzeQuery("UPDATE CUSTID_DETAILS SET state='KARNATAKA' WHERE id='abc'");
    expect(v.ok).toBeTruthy();
    expect(v.table).toBe('CUSTID_DETAILS');
    expect(v.where).toBe("id='abc'");
    expect(v.previewSql).toBe("SELECT * FROM CUSTID_DETAILS WHERE id='abc' LIMIT 501");
  });

  it('handles an alias in the ubi-backend style', () => {
    // Mirrors `UPDATE ${tableName} AS ${alias} SET ...` from sqlqueries.js
    const v = analyzeQuery("UPDATE APPLICANT AS APL SET APL.profile.name='x' WHERE APL.id='1'");
    expect(v.table).toBe('APPLICANT');
    expect(v.alias).toBe('APL');
    expect(v.where).toBe("APL.id='1'");
  });

  it('does not treat a SET value containing WHERE as the clause', () => {
    const v = analyzeQuery("UPDATE T SET note='WHERE id=1' WHERE id='real'");
    expect(v.where).toBe("id='real'");
  });

  it('HARD REJECTS an UPDATE with no WHERE', () => {
    const v = analyzeQuery("UPDATE CUSTID_DETAILS SET state='KA'");
    expect(v.blocked).toBeTruthy();
    expect(v.code).toBe('NO_WHERE');
  });

  it('rejects an UPDATE with no SET', () => {
    expect(analyzeQuery("UPDATE CUSTID_DETAILS WHERE id='1'").code).toBe('NO_SET');
  });

  it('handles a deep JSON path assignment', () => {
    const v = analyzeQuery(
      "UPDATE APPLICANT APL SET APL.docs.id.aadhaar.aadhaarOutput.name='X' WHERE APL.id='7'"
    );
    expect(v.ok).toBeTruthy();
    expect(v.where).toBe("APL.id='7'");
  });
});

describe('query-guard: ambiguity is refused, never guessed', () => {
  it('rejects two top-level WHERE keywords', () => {
    const v = analyzeQuery("DELETE FROM T WHERE a='1' WHERE b='2'");
    expect(v.blocked).toBeTruthy();
    expect(v.code).toBe('AMBIGUOUS_WHERE');
  });

  it('does not count a WHERE inside parentheses as top level', () => {
    // A subquery's WHERE belongs to the subquery, not the statement.
    const v = analyzeQuery(
      "DELETE FROM T WHERE id IN (SELECT id FROM U WHERE flag='y')"
    );
    expect(v.ok).toBeTruthy();
    expect(v.where).toBe("id IN (SELECT id FROM U WHERE flag='y')");
  });

  it('rejects an unterminated string', () => {
    expect(analyzeQuery("DELETE FROM T WHERE id='oops").code).toBe('UNTERMINATED_STRING');
  });

  it('rejects unbalanced parentheses', () => {
    expect(analyzeQuery("SELECT * FROM T WHERE (a='1'").code).toBe('UNBALANCED_PARENS');
  });

  it('rejects an empty WHERE clause', () => {
    expect(analyzeQuery('DELETE FROM T WHERE   ').code).toBe('EMPTY_WHERE');
  });

  it('rejects a malformed AS with no alias following', () => {
    expect(analyzeQuery("DELETE FROM T AS WHERE id='1'").code).toBe('CANNOT_PARSE_TABLE');
  });
});

describe('query-guard: double-quoted values (ubi-backend generates these)', () => {
  it('treats a double-quoted value as a string, not an identifier', () => {
    const v = analyzeQuery('SELECT * FROM ZONES_ROS_BRANCHES WHERE branch_code="1234"');
    expect(v.ok).toBeTruthy();
  });

  it('does not read -- inside a double-quoted value as a comment', () => {
    const v = analyzeQuery('SELECT * FROM T WHERE code="a--b"');
    expect(v.ok).toBeTruthy();
  });

  it('handles an escaped doubled quote inside a string', () => {
    const v = analyzeQuery("SELECT * FROM T WHERE name='O''Brien'");
    expect(v.ok).toBeTruthy();
  });
});

describe('query-guard: statementBadge (drives the live editor badge)', () => {
  it('reports the type for a valid query', () => {
    expect(statementBadge('SELECT * FROM T').label).toBe('SELECT');
    expect(statementBadge("DELETE FROM T WHERE id='1'").label).toBe('DELETE');
  });

  it('reports DROP TABLE as destructive rather than blocked', () => {
    const badge = statementBadge('DROP TABLE T');
    expect(badge.blocked).toBeFalsy();
    expect(badge.label).toBe('DROP TABLE');
    expect(badge.risk).toBe('destructive');
    expect(badge.requiresTypedConfirmation).toBeTruthy();
  });

  it('reports BLOCKED with a reason for things still refused', () => {
    const badge = statementBadge('DELETE FROM T');
    expect(badge.blocked).toBeTruthy();
    expect(badge.label).toBe('⛔ BLOCKED');
    expect(badge.reason).toContain('every row');
  });

  it('is blank for an empty editor rather than shouting BLOCKED', () => {
    expect(statementBadge('').label).toBe('');
    expect(statementBadge('   ').blocked).toBeFalsy();
  });

  it('surfaces the row cap for an unlimited SELECT', () => {
    expect(statementBadge('SELECT * FROM APPLICANT').effectiveLimit).toBe(500);
  });

  it('agrees with analyzeQuery — the badge cannot contradict the server', () => {
    const samples = [
      'SELECT * FROM T',
      'DROP TABLE T',
      'DELETE FROM T',
      "DELETE FROM T WHERE id='1'",
      "UPDATE T SET a='1' WHERE id='1'",
      'SELECT * FROM T; DROP TABLE T',
    ];
    for (const sql of samples) {
      expect(statementBadge(sql).blocked).toBe(analyzeQuery(sql).blocked);
    }
  });
});
