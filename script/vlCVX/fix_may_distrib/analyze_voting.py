import json
from decimal import Decimal
from typing import Dict, List, NamedTuple
from dataclasses import dataclass
import decimal
from pathlib import Path

# Type definitions
class TokenAmount(NamedTuple):
    amount: Decimal
    symbol: str

@dataclass
class GaugeReward:
    gauge_address: str
    rewards: List[TokenAmount]

# Define the rewards data
GAUGE_REWARDS = [
    GaugeReward(
        "0x26F7786de3E6D9Bd37Fcf47BE6F2bC455a21b74A",
        [TokenAmount(Decimal("1567927295753080644161"), "0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F")]
    ),
    GaugeReward(
        "0x92d956C1F89a2c71efEEB4Bac45d02016bdD2408",
        [
            TokenAmount(Decimal("16395860810649287194087"), "0x8207c1FfC5B6804F6024322CcF34F29c3541Ae26"),
            TokenAmount(Decimal("31441174855241166"), "0x856c4Efb76C1D1AE02e20CEB03A2A6a08b0b8dC3"),
            TokenAmount(Decimal("59682347986859164296"), "0x2A8e1E676Ec238d8A992307B495b45B3fEAa5e86")
        ]
    ),
    GaugeReward(
        "0xd03BE91b1932715709e18021734fcB91BB431715",
        [TokenAmount(Decimal("7183532567184369398919"), "0xD533a949740bb3306d119CC777fa900bA034cd52")]
    ),
    GaugeReward(
        "0xd8b712d29381748dB89c36BCa0138d7c75866ddF",
        [TokenAmount(Decimal("50918662804680252954517426"), "0x090185f2135308BaD17527004364eBcC2D37e5F6")]
    ),
    GaugeReward(
        "0x156527deF9a2AB4F54C849575f23dC4BB439d9d9",
        [TokenAmount(Decimal("19110055081343485623119"), "0xFa2B947eEc368f42195f24F36d2aF29f7c24CeC2")]
    ),
    GaugeReward(
        "0x7671299eA7B4bbE4f3fD305A994e6443b4be680E",
        [TokenAmount(Decimal("4857524453555506034523"), "0x30D20208d987713f46DFD34EF128Bb16C404D10f")]
    ),
    GaugeReward(
        "0x8f5e52BE9B7BDe850BA13e40284F63f14677058f",
        [TokenAmount(Decimal("273692934018850706018"), "0x41D5D79431A913C4aE7d69a668ecdfE5fF9DFB68")]
    ),
    GaugeReward(
        "0xa48A3c91b062ca06Fd0d0569695432EB066f8c7E",
        [TokenAmount(Decimal("157258798331183261850"), "0x41D5D79431A913C4aE7d69a668ecdfE5fF9DFB68")]
    ),
    GaugeReward(
        "0xd5f2e6612E41bE48461FDBA20061E3c778Fe6EC4",
        [TokenAmount(Decimal("9817135744"), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")]
    ),
    GaugeReward(
        "0x4e227d29b33B77113F84bcC189a6F886755a1f24",
        [TokenAmount(Decimal("1572911252"), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")]
    ),
    GaugeReward(
        "0x9da8420dbeebdfc4902b356017610259ef7eedd8",
        [TokenAmount(Decimal("4993526045722650720985"), "0x8ee73c484a26e0a5df2ee2a4960b789967dd0415")]
    )
]

# Users who voted by themselves (to be excluded)
SELF_VOTERS = {
    "0x0d0db6402196fb090cd251a1503b5688a30a6116",
    "0x181ae03a7f3f320ec1255c913c9cb63fce12f77a"
}

# Forwarders from the log file
FORWARDERS = {
    "0x781fea3353d6efbbabc9fac0b4725eff3c77dba7",
    "0x2dbedd2632d831e61eb3fcc6720f072eef9d522d",
    "0xea7c60ba79508855dc3c869dae5b407e6f9fc307",
    "0x544b4979263846cbc2bebf0b99d3812536964da5",
    "0x005ea0be32125792cbff9c6dbaf91a7001e43235",
    "0x8a474fd1b929306a6827630aefeade443128ec68",
    "0xb0e83c2d71a991017e0116d58c5765abc57384af",
    "0x71d92ce08bae1ecb7feea51e1ef0c2540d2b1751",
    "0x0d703ccd7debd7f6f4b0ffb29d2d710d19b09025",
    "0xf3df39bb5d9876e1c89d1a99b0f1e81d9b469f40",
    "0x5275817b74021e97c980e95ede6bbac0d0d6f3a2",
    "0xab8c43e0c7358b92b32816c2250aa3cdbb35555a",
    "0xe90b4aa6002e263031e9a05d50ce8709b9f92fa8",
    "0xadfc26b6520a35c37af3ac5af174249737ec612c",
    "0xcbb24aec855372d1e3078055a399c5ac5f8b39e5",
    "0x72f01e94c94a7ddf11a0e9ceedc19b6763032a9e",
    "0xf930ebbd05ef8b25b1797b9b2109ddc9b0d43063",
    "0xa98be71b3213e21d8014b41ac0309bc9dcca6b9a",
    "0x4c37cb037e379e39ec1e0b6a950a70ff080ea2a8",
    "0x321516d8fe2083eeeba69a1babb8fd7969493b1b",
    "0xfd16c43e6479da7888d73cf76cf9f7691ff67367",
    "0xa87308d1ab723b8595693eee7ae34599ae1af259",
    "0x99ed04c212dd3929e9063bd78b26ef41858cb62c",
    "0xca0073964efe7f9422ceb16901018b1db0cc4785",
    "0xc696481349f868f720fa40af1514362ee87b7458",
    "0xbcd3e2e841cc6140ede73c9ad8ad86ec7e423f52",
    "0xfc913f8f1845e0d12814b3e4d4a9f5a720d62327",
    "0xc53ae7ea9eeb4f55a73bed1008458a83e39c1e75",
    "0x118ad981e3be9a5a16ec7136125425af9c2128f4",
    "0x7e1ff06fc9adaca7383560f3d674c6b686aef67e",
    "0x6206798a980d13d34b7078be0f95e2f4c3146dd0",
    "0x29015220782d9d9b455597fa44e81094257596af",
    "0xcc0b4fb77e21894120699e6d198ca611b082766d",
    "0x3b2b389e6ba7cd904abcf3d213515e652cb60073",
    "0x48d18a882b0be145606a11fce6f8a301256b93fa",
    "0xdfd24769ed77f254959e79ee47e78ae7a21ef4ee",
    "0x158072f5e37df21abf0b8c23ec94d09bab2f024f",
    "0x6ee5bef0c49154f89749ab4057683da6f4429331",
    "0x5467fa63165a3cf5ac6a6b80e3c685e578ba9eca",
    "0x9781f72f15ff9d961f5b0aaf1d93b40c23905f05",
    "0x4dc97041d9f37b3b89d793cbf9b8313f36266e15",
    "0x4082ba9a40e2697b6fcb68ec9b856c19048f99da",
    "0xd4f9fe0039da59e6ddb21bbb6e84e0c9e83d73ed",
    "0x39d04336788300784d10894e84642bcb07dc6434",
    "0x04239c89be7b407fa49bb6f9464b8454f69d3f46",
    "0xf2d3a7ed6eae607dbc47614f2db7cb3676dce6cf",
    "0x4f22b4562647b5b63433cebddf28dfe42fcf2c2d",
    "0xdb6b9c3439a326ce8f816971d540e18089743a5d",
    "0xe3295c57cbe8ff490decc4af8a32e1cbe7f5291f",
    "0x46038e1051dfe73f3b0727e6c2538ffa2c6eae34",
    "0xc4fdde0e46f266367bfab19f662265ab8e341842",
    "0x095cbf84f149f12ce5625ea023ad0133cd84a503",
    "0xfdec357f13b8cc6802a770a57190710ee12257f9",
    "0xf0d48f76b9fc797bdf255136ae6f22bb47a34c35",
    "0x4daf8ce9d729ca4f121381ec4b22123627c1c004",
    "0xd0a8a6dd88bd9405128f178347ecd60faa631164"
}

# Non-forwarders from the log file
NON_FORWARDERS = {
    "0xe001452bec9e7ac34ca4ecac56e7e95ed9c9aa3b",
    "0x41d7e3da4678ac1f5b7f607c9f6f2140b87adc7c",
    "0xae5eacaf9c6b9111fd53034a602c192a04e082ed",
    "0xaa68ad0bfeee7d0feba2d9d606e62e24a68a4252",
    "0xe73ba8c97be1999705ac74f3e046687a173d4afb",
    "0x3f47a66ada01491c3d364599e5bcbf80a1a67092",
    "0x3ac892a09165516d98ec9c02b95ff840ab4badae",
    "0xc0c21f1ae0c7c194a76168288dd251e0cd551ac4",
    "0xcb397b4e2612ee99a1591cb40db3c837bc1b2c35",
    "0xb82be987cf6f25d0f040ca4567e3dacb4b92aa91",
    "0x16f562fb6587a19e19761654adb195f8bc879b5d",
    "0x425d97d186357d596b5b0b9b36a361aacb20337d",
    "0xfd90eb8fa533c9608037dea32784f1f9656606c0",
    "0x4607a9b0553afd468cf847324764184edc17ad5c",
    "0x359fc0ec3f26cb7242ab362e9bf1db9e79ac0698",
    "0x7d7c4daba895fa235e71307bbc190d8325b8ca41",
    "0x299d7c375add719fb6d0412895439aaca810029a",
    "0xcb76bddbbb87ba2bf76460aa177924cd1e9524b5",
    "0xc88b55a947b42bab0b75c133def68cee5b8e450e"
}


def load_json(file_path: str) -> Dict:
    """Load and parse JSON file."""
    with open(file_path, 'r') as f:
        return json.load(f)


def calculate_gauge_rewards(voting_data: Dict) -> Dict[str, Dict[str, Decimal]]:
    """Calculate rewards for each gauge and return voter rewards."""
    voter_rewards = {}
    voting_data_normalized = {k.lower(): v for k, v in voting_data.items()}
    
    for gauge in GAUGE_REWARDS:
        gauge_address = gauge.gauge_address.lower()
        
        if gauge_address not in voting_data_normalized:
            print(f"  WARNING: Gauge not found in voting data")
            continue
            
        gauge_data = voting_data_normalized[gauge_address]
        total_votes = Decimal(str(gauge_data.get("total", 0)))
        
        if total_votes == 0:
            print(f"  WARNING: No votes found for gauge")
            continue
            
        for reward in gauge.rewards:
            token = reward.symbol
            total_amount = reward.amount
            distributed = Decimal('0')
            
            # Calculate each voter's share
            voter_shares = {}
            for voter, vote in gauge_data.get("votes", {}).items():
                try:
                    vote_decimal = Decimal(str(vote))
                    share = vote_decimal / total_votes
                    amount = (total_amount * share).quantize(
                        Decimal('1'),
                        rounding=decimal.ROUND_DOWN
                    )
                    voter_shares[voter] = amount
                    distributed += amount
                except (decimal.InvalidOperation, decimal.DivisionByZero) as e:
                    print(f"  Error processing vote for voter {voter}: {e}")
                    continue
            
            # Last voter gets remaining amount to ensure exact total
            if voter_shares:
                last_voter = list(voter_shares.keys())[-1]
                remaining_amount = total_amount - distributed
                voter_shares[last_voter] += remaining_amount
            
            # Add to voter rewards
            for voter, amount in voter_shares.items():
                if voter not in voter_rewards:
                    voter_rewards[voter] = {}
                if token not in voter_rewards[voter]:
                    voter_rewards[voter][token] = Decimal('0')
                voter_rewards[voter][token] += amount
    
    return voter_rewards


def analyze_group_totals(voter_rewards: Dict[str, Dict[str, Decimal]]) -> None:
    """Calculate and display totals for each group."""
    forwarder_totals = {}
    non_forwarder_totals = {}
    other_totals = {}
    other_addresses = {}  # Store individual totals for other addresses
    
    # Process each voter's rewards
    for voter, token_amounts in voter_rewards.items():
        voter = voter.lower()
        
        # Skip self-voters
        if voter in SELF_VOTERS:
            continue
            
        # Add to appropriate totals
        if voter in FORWARDERS:
            target_totals = forwarder_totals
        elif voter in NON_FORWARDERS:
            target_totals = non_forwarder_totals
        else:
            target_totals = other_totals
            # Store individual totals for other addresses
            if voter not in other_addresses:
                other_addresses[voter] = {}
            
        for token, amount in token_amounts.items():
            if token not in target_totals:
                target_totals[token] = Decimal('0')
            target_totals[token] += amount
            
            # Store individual totals for other addresses
            if voter in other_addresses:
                if token not in other_addresses[voter]:
                    other_addresses[voter][token] = Decimal('0')
                other_addresses[voter][token] += amount
    
    # Print results
    print("\nForwarder Totals:")
    for token, amount in sorted(forwarder_totals.items()):
        print(f"{token}: {str(amount).replace(',', '')}")
        
    print("\nNon-Forwarder Totals:")
    for token, amount in sorted(non_forwarder_totals.items()):
        print(f"{token}: {str(amount).replace(',', '')}")
        
    print("\nOther Users Totals:")
    for token, amount in sorted(other_totals.items()):
        print(f"{token}: {str(amount).replace(',', '')}")
    
    # Print individual totals for other addresses
    print("\nIndividual Totals for Other Addresses:")
    for address, token_amounts in sorted(other_addresses.items()):
        print(f"\nAddress: {address}")
        for token, amount in sorted(token_amounts.items()):
            print(f"  {token}: {str(amount).replace(',', '')}")


def main():
    # Load voting data
    voting_data = load_json("script/vlCVX/fix_may_distrib/Round95Aggregated.json")
    
    # Calculate rewards
    voter_rewards = calculate_gauge_rewards(voting_data)
    
    # Analyze and display group totals
    analyze_group_totals(voter_rewards)


if __name__ == "__main__":
    main()