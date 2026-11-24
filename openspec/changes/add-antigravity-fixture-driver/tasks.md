## 1. Driver

- [x] 1.1 Implement `src/testing/antigravity-driver.ts` with every `FixtureDriver` step, fake `processes`, `prepareLock`, `spawnHolder` and `dispose`; export it from `src/testing/index.ts`
- [x] 1.2 Reuse the driver's protobuf encoder in `test/providers/antigravity-cli/fixtures.ts`

## 2. Verification

- [x] 2.1 Run the conformance kit against `antigravityCli` with the driver (`test/testing/antigravity-conformance.test.ts`)
- [x] 2.2 Test real holders: pid and cwd bound, exit closes and keeps history, a new holder resumes, a caller-started holder from `prepareLock` (`test/testing/antigravity-driver.test.ts`)
- [x] 2.3 Test that tool, failed-turn, subagent, background-wait and metadata steps reach the provider
- [x] 2.4 Extend the pack and type-usage tests; update the README testing kit section
- [x] 2.5 Run `npm run lint`, `npm test` and `openspec validate --all`
