# Lot 002 — Ne jamais valider un index incomplet

Priorité P1 ; effort M ; risque moyen ; livraison après 001. Préparé le 12 novembre 2026 au commit local `574463d37ff590b8f9d9c44f898b466409b78032`, helpers identiques au main observé `a9f0778229e230502f9c9fe9bd20bcd4c029a692`.

## But et preuve

Le run https://github.com/stake-dao/bounties-report/actions/runs/43221832855 affiche une divergence de quatre délégateurs `sdcrv.eth`, puis termine vert. `script/indexer/delegators.ts` termine par `main().catch(console.error)` : l’erreur est affichée, sans échec du processus. Le collecteur Snapshot peut aussi masquer un trou réseau et écrire un checkpoint qui empêche sa récupération.

```ts
// script/utils/cacheUtils.ts:331–339
        console.error(
          `fetchLogs: All ${maxRetries} retries failed for blocks ${startBlock}-${endBlock}`
        );
        // Return empty array but log the gap for manual review
        console.error(
          `  WARNING: Potential gap in data between blocks ${startBlock}-${endBlock}`
        );
        return [];
```

`fetchAllDelegators` écrit un EndBlock après la collecte. `readParquetFile` transforme également une erreur de lecture en `[]`. La boucle utilise `currentBlock < endBlock` alors que les bornes des chunks sont inclusives. À l’inverse, `forwarderCacheUtils.ts` lève déjà une erreur après épuisement des tentatives : reprendre ce comportement, sans réécrire tout le stockage.

## Périmètre et dérive

`script/utils/cacheUtils.ts`, `script/indexer/delegators.ts`, nouveaux `script/test/unit/delegatorCacheIntegrity.test.ts` et `script/test/unit/delegatorIndexerFailure.test.ts`. `script/utils/delegationAPIUtils.ts` est d’abord en lecture seule pour diagnostiquer la divergence. Ne l’éditer qu’après preuve d’une erreur de comparaison et mise à jour explicite de ce périmètre. Ne pas modifier les parquets publiés, les bénéficiaires, les tolérances ni les workflows financiers.

Contrôler `git diff --stat 574463d37ff590b8f9d9c44f898b466409b78032..HEAD -- script/utils/cacheUtils.ts script/indexer/delegators.ts script/utils/delegationAPIUtils.ts`, puis les changements non committés. Le lot 001 ne modifie pas ces sources.

## Exécution et vérification

1. Ajouter les régressions par `fetchAllDelegators` et `processAllDelegators`, avec un répertoire temporaire isolé et des réponses explorer/RPC maîtrisées. Modèle Vitest : `script/test/unit/forwarderCache.test.ts` ; comparer le contenu conservé et les événements lus, pas les appels internes de fonctions privées. Aucun test ne doit écrire dans `data/delegations` du checkout.
2. Faire échouer la collecte à l’épuisement des tentatives et à une réponse invalide. Un résultat vide valide reste permis. Une erreur de lecture d’un parquet existant doit se propager ; fichier absent reste le cas de bootstrap. Ne pas avancer ni réécrire le fichier de ce couple chaîne/adresse si la collecte ou la lecture échoue. Pas de transaction globale entre toutes les chaînes : les couples déjà entièrement réussis peuvent rester actualisés.
3. Corriger les bornes inclusives pour que le bloc final soit effectivement scanné, notamment quand `latestProcessedBlock + 1 === endBlock`. Couvrir ce bloc avec un événement unique ; couvrir aussi un chunk vide valide et deux chunks dont le second échoue.
4. Retourner un code non nul depuis le CLI en cas d’exception réseau ou de vérification, après journalisation. Ajouter un test du point d’entrée exécuté dans un environnement isolé avec ses dépendances remplacées ; le contrat attendu est le code de sortie, pas le texte exact du log. Ne pas extraire un framework CLI pour ce cas.
5. Diagnostiquer séparément la divergence sdCRV en lecture seule : même timestamp, mêmes événements, état de la source GraphQL et progression de son index. Distinguer retard de l’API, filtre et replay incorrects. Ne pas faire de la comparaison actuelle à « maintenant » une preuve de l’état du run historique. Si les événements historiques nécessaires sont indisponibles, enregistrer la limitation et bloquer la livraison du durcissement global jusqu’à décision ; ne pas masquer l’échec.

Contrôles : `pnpm exec vitest run script/test/unit/delegatorCacheIntegrity.test.ts script/test/unit/delegatorIndexerFailure.test.ts script/test/unit/forwarderCache.test.ts`, puis `pnpm test:unit`. Résultat attendu : échec réseau/corruption = rejection et fichier précédent inchangé ; reprise = même plage réessayée ; événement au bloc final présent une seule fois ; divergence = processus non nul. Les tests de CLI sont des exécutions isolées avec mocks, pas des appels réels à l’indexeur.

## Critères et limites

- [ ] Aucun trou réseau n’est validé comme checkpoint réussi.
- [ ] Un parquet existant illisible n’est pas remplacé par un bootstrap silencieux.
- [ ] La dernière borne inclusive est testée et conservée.
- [ ] Une erreur de vérification échoue réellement dans le CLI.
- [ ] La divergence sdCRV dispose d’un diagnostic sourcé ou la livraison est marquée BLOCKED.

Arrêter si la correction exige de reconstruire les historiques ou de redéfinir les règles financières. Préparer ce travail séparément avec ses preuves et autorisations. Rollback par revert du code uniquement ; aucun écrasement de données de production.

## Clôture à remplir

Collecteurs durcis ici : échec réseau/réponse invalide/corruption propagé sans réécriture du checkpoint ; dernière borne inclusive corrigée. Sept régressions via les API publiques avec vrais Parquets temporaires, rouges avant correction puis vertes. Périmètre étendu à `forwarderCacheUtils.ts` après reproduction des mêmes défauts ; pas de modification du modèle de stockage ni des filtres d’événements.

Diagnostic sdCRV reproduit : GraphQL Ethereum est au bloc 26247263, avant les quatre Set aux blocs 26289842, 26298308, 26310494 et 26364024. Lectures RPC du registre au bloc 26399808 (hash `0xb275c29c61aab3daa1df1ae240526f3df1b48a832931140dbd51ccdbe8af0236`) : les quatre délèguent bien à Stake DAO. Ne pas supprimer leurs lignes. La correction CLI/fraîcheur reste sous la propriété du thread parallèle, dans [PR #251](https://github.com/stake-dao/bounties-report/pull/251), non fusionnée et non cherry-pickée ici. Le lot complet nécessite les deux PR ; aucun code de l’autre thread copié sans approbation. Voir [le journal](EXECUTION.md).
