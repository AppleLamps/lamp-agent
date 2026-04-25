import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from calculator import broken_add


def test_broken_add_returns_the_correct_sum():
    # Deliberately fails: broken_add is off by one.
    assert broken_add(2, 3) == 5
