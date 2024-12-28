import { getProposal } from './utils/snapshot';
import { getDelegationVotingPower } from './utils/utils';

async function testDelegationVotingPower() {
  const proposal = await getProposal("0xdd4922d3b9980b2049967ab99cc13611acfed8f4d94b6a316e5844d3a01fc4f0");

  // List of delegator addresses to check
  const delegators = [
    '0x7Ac6B7869Be51990CD6Cf726eF44e821DEDE7b12', // Replace with actual addresses
    '0x7f955a67EdBaD58547Eb4Ed729f64C5aa70cc349',
    '0x955aF4de9Ca03f84c9462457D075aCABf1A8AfC8'
  ];

  // Network ID (1 for Ethereum mainnet)
  const network = '1';

  try {
    const votingPower = await getDelegationVotingPower(proposal, delegators, network);
    console.log('Voting Power Results:');
    console.log(JSON.stringify(votingPower, null, 2));
  } catch (error) {
    console.error('Error:', error);
  }
}

testDelegationVotingPower();