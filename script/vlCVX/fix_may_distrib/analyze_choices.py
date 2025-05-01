import json
from typing import List
# Choices to focus on
TARGET_CHOICES = {139, 408, 129, 27, 424, 179, 363, 384, 97, 167, 533}

# List of delegators
DELEGATORS = {
    "0x0d0db6402196fb090cd251a1503b5688a30a6116",
    "0x181ae03a7f3f320ec1255c913c9cb63fce12f77a",
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
    "0xd0a8a6dd88bd9405128f178347ecd60faa631164",
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


def load_json(file_path: str) -> List:
    """Load and parse JSON file."""
    with open(file_path, 'r') as f:
        return json.load(f)


def check_delegator_votes(pre_del: List, post_del: List) -> None:
    """Check which delegators voted by themselves."""
    # Create sets of voters from both files
    pre_voters = {item["voter"].lower() for item in pre_del}
    post_voters = {item["voter"].lower() for item in post_del}
    
    # Normalize delegator addresses
    delegators_normalized = {addr.lower() for addr in DELEGATORS}
    
    # Find delegators who voted in pre-del
    pre_voting_delegators = delegators_normalized & pre_voters
    print("\nDelegators who voted in pre-del:")
    for delegator in sorted(pre_voting_delegators):
        print(f"  {delegator}")
    
    # Find delegators who voted in post-del
    post_voting_delegators = delegators_normalized & post_voters
    print("\nDelegators who voted in post-del:")
    for delegator in sorted(post_voting_delegators):
        print(f"  {delegator}")
    
    # Find delegators who voted in both
    both_voting_delegators = pre_voting_delegators & post_voting_delegators
    print("\nDelegators who voted in both files:")
    for delegator in sorted(both_voting_delegators):
        print(f"  {delegator}")


def analyze_choices(pre_del: List, post_del: List) -> None:
    """Analyze differences in choices between pre and post delegation."""
    # Create normalized dictionaries from lists
    pre_del_normalized = {
        item["voter"].lower(): item
        for item in pre_del
    }
    post_del_normalized = {
        item["voter"].lower(): item
        for item in post_del
    }
    
    # Find voters that disappeared
    disappeared_voters = set(pre_del_normalized.keys()) - set(post_del_normalized.keys())
    
    # Filter for voters with target choices
    relevant_disappeared = []
    for voter in disappeared_voters:
        choices = pre_del_normalized[voter].get("choice", {})
        if any(str(choice) in choices for choice in TARGET_CHOICES):
            relevant_disappeared.append(voter)
    
    # Print disappeared voters
    print("\nVoters that disappeared (with target choices):")
    for voter in sorted(relevant_disappeared):
        print(f"\nAddress: {voter}")
        choices = pre_del_normalized[voter].get("choice", {})
        for choice, amount in choices.items():
            if int(choice) in TARGET_CHOICES:
                print(f"  Choice {choice}: {amount}")
    
    # Analyze choice changes for voters in both files
    print("\nChoice changes for voters in both files:")
    for voter in sorted(set(pre_del_normalized.keys()) & set(post_del_normalized.keys())):
        pre_choices = pre_del_normalized[voter].get("choice", {})
        post_choices = post_del_normalized[voter].get("choice", {})
        
        # Check if voter has any target choices
        has_target_choices = any(
            str(choice) in pre_choices or str(choice) in post_choices
            for choice in TARGET_CHOICES
        )
        
        if not has_target_choices:
            continue
            
        # Find differences in target choices
        differences = []
        for choice in TARGET_CHOICES:
            choice_str = str(choice)
            pre_amount = pre_choices.get(choice_str, 0)
            post_amount = post_choices.get(choice_str, 0)
            
            if pre_amount != post_amount:
                differences.append((choice, pre_amount, post_amount))
        
        if differences:
            print(f"\nAddress: {voter}")
            for choice, pre_amount, post_amount in differences:
                print(f"  Choice {choice}:")
                print(f"    Before: {pre_amount}")
                print(f"    After:  {post_amount}")


def main():
    # Load pre and post delegation data
    pre_del = load_json("script/vlCVX/fix_may_distrib/Round95PreDel.json")
    post_del = load_json("script/vlCVX/fix_may_distrib/Round95PostDel.json")
    
    # Check which delegators voted
    check_delegator_votes(pre_del, post_del)
    
    # Analyze differences
    analyze_choices(pre_del, post_del)


if __name__ == "__main__":
    main() 