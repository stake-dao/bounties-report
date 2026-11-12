# Lot 001 — Limiter chaque workflow à ses dépendances

Priorité P1 ; effort S ; risque faible ; aucune dépendance. Préparé le 12 novembre 2026 au commit local `574463d37ff590b8f9d9c44f898b466409b78032`, comparé à main `a9f0778229e230502f9c9fe9bd20bcd4c029a692`.

## But et état actuel

Le run https://github.com/stake-dao/bounties-report/actions/runs/43221832855 passe 14 min 03 s dans `get-delegators` après les claims Votium. Cette commande indexe le registre Snapshot ; vlCVX utilise `GaugeDelegation` depuis le cutover on-chain documenté dans `docs/ENG-1973-checklist-cutover.md`. Le cache de forwarders Votium est distinct et nécessaire avant les claims.

Extraits actuels :

```yaml
# .github/workflows/claims.yaml
      - name: Run delegators indexer (convex-votium only)
        if: env.PLATFORM == 'convex-votium'
        run: make -f automation/indexer.mk get-delegators
```

```ts
// script/indexer/delegators.ts:15–24
  await fetchAllDelegators("1", [
    DELEGATION_ADDRESS,
    AUTO_VOTER_DELEGATION_ADDRESS,
  ]);
  await fetchAllDelegators("56", [DELEGATION_ADDRESS]);
  await fetchAllDelegators("8453", [DELEGATION_ADDRESS, AUTO_VOTER_DELEGATION_ADDRESS]);
```

L’indexeur global alimente d’autres produits : `SPACE_TO_CHAIN_ID` associe sdCAKE à 56 et Spectra à 8453 ; `script/spectra/2_repartition.ts` lit `processAllDelegators`. Son défaut multichaîne doit rester inchangé. Aucun appelant identifié n’a besoin d’un nouveau sélecteur de chaînes après le retrait de l’étape Votium : ne pas en ajouter.

## Périmètre et dérive

Modifier uniquement `.github/workflows/claims.yaml`. Lire les helpers et l’indexeur pour vérifier les dépendances, sans les modifier. Aucun changement de CLI, schedule, données, règles de répartition ni de `constants.ts`.

Avant édition : `git diff --stat 574463d37ff590b8f9d9c44f898b466409b78032..HEAD -- .github/workflows/claims.yaml` puis `git diff -- .github/workflows/claims.yaml`. Les protections CA ajoutées sur main sont attendues et doivent rester.

## Exécution et contrôles

1. Confirmer par les imports de `generateConvexVotium.ts`, `effectiveVotes.ts` et `onChainDelegation.ts` que les claims n’utilisent pas le parquet Snapshot. Retirer seulement l’étape post-claims et ses variables d’environnement locales. Vérifier que `get-forwarders` précède toujours la génération et que les autres plateformes de Claims sont inchangées. Contrôle : `rg -n 'get-delegators|get-forwarders|Generate claims' .github/workflows/claims.yaml` ne montre plus `get-delegators`, mais garde les deux autres étapes dans cet ordre.
2. Vérifier le diff YAML : aucune autre étape retirée, ni secret global supprimé, ni modification des plateformes ou du dispatch. `system-indexer.yaml` garde son indexation globale et son cron actuel.
3. Parser/linter le YAML selon les outils disponibles. Une vérification temporaire du document parsé confirme que l’étape forwarders précède toujours Generate claims, et qu’aucune étape Claims n’invoque `get-delegators`. Ne pas conserver un test permanent qui fige le texte du workflow.

Vérification : `git diff --check`, contrôle du YAML et baseline ciblée `pnpm exec vitest run script/test/unit/convexVotiumForwarderVp.test.ts script/test/unit/votiumClaimAllocations.test.ts` : succès. `git diff --exit-code -- script/indexer/delegators.ts .github/workflows/system-indexer.yaml` ne montre aucun changement de ce lot. Ne pas exécuter le générateur réel pour vérifier ce retrait.

## Critères, arrêt et retour arrière

- [ ] Claims ne déclenche plus le registre Snapshot et garde l’indexeur forwarders avant la génération.
- [ ] L’indexeur global et son périmètre 1,56,8453 sont inchangés ; aucun nouveau CLI ajouté.
- [ ] YAML et tests ciblés vérifiés ; aucune donnée générée modifiée.

Arrêter si un consommateur effectif des claims dépend encore du parquet Snapshot ou si main a changé de modèle de délégation. Ne pas retirer ce consommateur pour faire correspondre le code au plan. Revert possible sans migration de données.

## Clôture à remplir

Implémenté sur `fix/ci-network-efficiency`. Étape post-claims et son environnement local supprimés, indexeur forwarders conservé avant les claims, indexation globale inchangée. Assertion YAML observée rouge puis verte ; tests forwarders/allocations verts ; actionlint sans ShellCheck valide. Les SC2086 préexistants ne sont pas corrigés. Aucun générateur exécuté. 14 min 03 s est le coût retiré du run de référence, pas un benchmark d’un nouveau run. Voir [le journal](EXECUTION.md) pour l’état de livraison.
