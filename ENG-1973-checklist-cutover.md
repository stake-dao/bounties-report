# ENG-1973 — Checklist cutover on-chain (semaine du 3 août 2026)

> Branche `feature/eng-1973-automation-change-votes-logic-from-snapshot-to-on-chain` (PR #155).
> Premier round prod on-chain : proposal **#0**, epoch vlCVX **230**, plateformes redéployées le 25/07
> (Curve `0x64D9B5AC386B70af9EDCD20A58cE9262D2EAC278`, FXN `0xDcEa673B021f1f431E7D0Ec70a63bF8DcB6d44E6`, poids en ppm).
> Dry-run e2e du 2/08 : mécanique validée au wei près — rapport : https://claude.ai/code/artifact/195ee324-aa7b-4a8e-a2fe-5409aa2b08d4

## Décision push

- **Fenêtre de merge sûre : mardi 4/08 après le commit `publish-delegators` (~10:36-15:00 UTC) → mercredi 5/08 au soir.**
- **Ne PAS merger avant la fin du cycle délégateurs de mardi** : l'étape publish-delegators exécute
  `computevlCVXDelegatorsAPR.ts` — sur la branche il lirait la proposal on-chain (epoch 230, 342 forwarders)
  alors que la distribution publiée mardi est le split Snapshot du 30/07 (360 forwarders) → `APRs.json` incohérent.
  (Le chemin de l'argent de mardi est lui insensible au merge : merkle = fichiers committés, verifier try/catch-é.)
- Deadline dure : **jeudi 6/08 00:15 UTC** (pipeline `votemarket-v2` = premier consommateur du code branche).
  Si le claim Votium est réactivé cette semaine : merger avant **mercredi 10:00 UTC**.
- Après merge : ne pas re-dispatcher d'étape vlCVX d'une période passée (le code ne lit que la DERNIÈRE proposal
  on-chain) — si nécessaire, le faire depuis un commit pré-merge.

---

## Lundi 3/08

- [ ] **Vote du délégué — MANUEL** (bloqueur n°1 — 9,88 M vlCVX) : aucun bot ne vote ; `delegation_reminder.py`
  (automation-jobs) n'est qu'un filet de sécurité Telegram (alertes H-24 ce soir ~00:00 UTC et H-2 mardi ~22:00 UTC,
  surveillant les NOUVELLES plateformes depuis PR #952 mergée le 30/07). **Quelqu'un doit voter à la main sur la
  plateforme Curve avant mardi 00:00 UTC.** Vérifier :
  ```bash
  cast call 0x64D9B5AC386B70af9EDCD20A58cE9262D2EAC278 \
    "getVote(uint256,address)(address[],uint256[],bool,uint256,int256)" \
    0 0xbB06fEFB8f23A7c60C93fe20464DB6687C51955f \
    --rpc-url https://ethereum-rpc.publicnode.com
  # attendu: voted=true (3e valeur) — au 2/08 15:35 UTC c'était false sur Curve ET FXN
  ```
- [ ] Swaps Votium du cycle délégateurs (5×/4h) : des dépôts sCRVUSD continuent d'arriver sur `0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380`.

## Mardi 4/08 (ordre chronologique)

- [ ] **00:00–00:10 UTC** : fin du vote (+10 min overtime equalizer/Votium).
  - Re-check vote du délégué (commande de lundi) : `voted=true` sur Curve — sinon la délégation est hors round (9,88 M vlCVX).
  - Couverture finale : combien des 17 gauges Curve bountiés (cvx.csv) sont dans `getGaugeCount(0)` ? Au 2/08 : 6/17 seulement (32 early voters) — Votium vote en fin de round.
- [ ] **~09-10h Paris** : pipeline `vlcvx-delegators` (code main, période 30/07) — vérifier que l'allocation n'est PAS vide (`Final crvUSD per token` ≠ `{}`) : avec 4-6 dépôts de swap séparés, `mapTokenSwapsToOutToken` ne lit que la **première tx** (`vmTxHashes[0]`, `createDelegatorsMerkle.ts:339`) — si l'accounting sort faux/vide en prod ce mardi, c'est ce point-là (pré-existant, hors branche).
- [ ] **≥10:36 UTC : commit `chore: vlCVX publish-delegators`** = dernière distribution Snapshot de vlCVX terminée. Vérifier que `APRs.json` committé avec est cohérent (calculé par main, ~360 forwarders Snapshot). **NE PAS merger avant ce commit.**
- [ ] **Dry-run final sur le vote réel** (proposal finale, sans escape hatch ni vote simulé) :
  ```bash
  git worktree add /tmp/eng1973-final feature/eng-1973-automation-change-votes-logic-from-snapshot-to-on-chain
  cd /tmp/eng1973-final && ln -s <repo>/node_modules node_modules && cp <repo>/.env .env
  FORCE_UPDATE=true pnpm tsx script/vlCVX/2_repartition/index.ts
  # attendu: completeness deficit 0.000%, split forwarders/nonForwarders cohérent,
  # gauges skippés = uniquement les bountiés restés à 0 vote après le vote final
  # (pas de RPC_URL_1 ni VLCVX_ALLOW_ACTIVE_PROPOSAL: mainnet réel, proposal finale)
  # puis: git -C /tmp/eng1973-final diff --stat && git worktree remove --force /tmp/eng1973-final
  ```
- [ ] **Merge de la PR #155** sur main, idéalement 15:00-18:00 UTC (adresses redéployées incluses — commit `a721df7c`).
  Garde-fou : si le merge partait par erreur avant publish-delegators, seul `APRs.json` de mardi serait faussé
  (métrique) — le merkle et le submitRoot de mardi sont insensibles au code de la branche.

## Mercredi 5/08

- [ ] Filet de sécurité : si pas mergé mardi, **merger avant ce soir** (avant 10:00 UTC si claim Votium réactivé — slot biweekly semaine ISO paire).
- [ ] Décision équipe : réactivation du flux Votium (`claims.yaml` platform=convex-votium, D6) — en pause depuis février, fee forwarders = 0 tant que `forwarders_voted_rewards.json` est absent.

## Jeudi 6/08 — premier run prod on-chain 🎯

- [ ] ~00:40 UTC : commit `Update delegation data` (cron indexer).
- [ ] ~01:20 UTC : commits `convex-votemarket-v2 claims` → `vlCVX report` (cvx.csv/cvx_fxn.csv) → `vlCVX repartition` (+15 s) → `vlCVX voters-merkle` (+2 min).
- [ ] Dans les logs du run repartition : `on-chain proposalId 0 (vlCVX epoch 230)`, `Delegators completeness … deficit 0.000%`, pas de throw. Les warn `Skipping gauge absent from the proposal` sont normaux pour les gauges restés sans vote.
- [ ] Côté FXN : proposal #0 traitée aussi (7+ gauges) ; si le délégué n'a pas voté FXN, le log `Delegation address is not among voters; skipping` est attendu (pas de part délégation côté FXN).
- [ ] `snapshotBlock` des JSON produits = **230** (epoch, plus un numéro de bloc) — vérifier qu'aucun consommateur aval ne casse.
- [ ] Matin : submitRoot (process_thursday.py, chains 1/42161/8453) ; **12:00 UTC** sweep acceptRoot ; commit `publish-voters` ≥ 12:02.
- [ ] Réconciliation : total distribué vs CSV — les montants des gauges bountiés sans vote restent dans le wallet de distribution (pas perdus, mais non réalloués automatiquement) → les tracer.

## Dimanche 9/08 → Mardi 11/08

- [ ] Dim : swaps VM (6×/4h) ; lun : swaps Votium — dépôts sCRVUSD sur `0x17F5…F380`.
- [ ] **Mardi 11/08 ~09-10h Paris : PREMIER merkle délégateurs alimenté par le code de la branche** (répartition on-chain du jeudi 6). Vérifier : allocation non vide, 342+ forwarders payés pro-rata des poids synced, somme = pool sCRVUSD, delta FEE_RECIPIENT (0 si Votium toujours en pause), puis submitRoot → acceptRoot 10:00 UTC → publish ≥ 10:36.

---

## Points de vigilance connus (hors chemin critique)

1. **Fichiers stale en re-run** : avec `FORCE_UPDATE`, un `repartition_delegation.json` (ou `*_8453.json`) existant n'est pas réécrit quand le calcul est skippé (délégué sans vote / gauge non voté) → le merkle consomme l'ancien fichier. Durcissement possible : `rmSync` avant calcul (comme le L5 de `generateConvexVotium`).
2. **`mapTokenSwapsToOutToken` mono-tx** (`createDelegatorsMerkle.ts`) — voir mardi 4.
3. **`snapshotAnalyzer.ts` casse pour cvx.eth** avec des proposals Snapshot legacy (garde epoch dans `fetchDelegatorData`) — à migrer ou assumer.
4. Test unitaire du chemin « gauge absent du mapping » supprimé sans remplaçant (`nonDelegators.test.ts`).
5. `VLCVX_ALLOW_ACTIVE_PROPOSAL` et `RPC_URL_<chainId>` : test-only, aucun garde-fou prod, non documentés hors commentaires.
6. Env local : `pnpm install --frozen-lockfile` échoue (lockfile v6 vs pnpm 10 ; tsx local 4.21 < ^4.23) — sans impact CI ; à régler sur main un jour.

## Readiness des autres repos (vérifié le 2/08)

| Repo | Verdict | Notes |
|---|---|---|
| automation-jobs | ✅ | Nouvelles adresses sur main (PR #952 / ENG-2061, 30/07, + test de pinning). Distribution scripts sans dépendance aux plateformes de vote. ⚠️ `develop` a encore les vieilles adresses ; **PR #917 (ouverte) est stale et réintroduirait les vieilles adresses → rebaser avant merge**. Confirmer que le scheduler externe du reminder tourne sur un build ≥ 30/07. |
| automation-guard | ✅ | Adresses OK, ENG-2053 mergé, **batch Safe exécuté on-chain** (guard rules live). Non requis pour la semaine. Follow-up : unpause le pipeline Maestro. |
| backend-monorepo | ⚠️ | **PR #375 pointe les plateformes MORTES** (branche du 16/07, pré-redéploiement) ; aucune branche n'a les nouvelles adresses. À faire : bump `packages/api-v2/app/vlcvx/constants.py`, rebase main, re-vérif sur proposal #0. Non bloquant pour jeudi (analytics read-only, hors chemin de l'argent). |

## Références

- Ancien round accessible sur les anciens contrats uniquement (historique remis à 0 au redéploiement) :
  Curve `0x21F304a9DF75E087A035B4c5792bD4e6BB7AF8aF`, FXN `0xC3701a7696Cd41a4E3e107B8A7b897A3aFB4c50a`.
- Distributeurs : voters `0x000000006feeE0b7a0564Cd5CeB283e10347C4Db` (1/10/42161/8453), délégateurs `0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380` (mainnet).
- Délégué on-chain StakeDAO : `0xbB06fEFB8f23A7c60C93fe20464DB6687C51955f` · GaugeDelegation : `0xb8270eef1319173dE9f5033FED442F638ff1607d`.
- Rapport dry-run : artifact ci-dessus · CSV par adresse : scratchpad session du 2/08.
