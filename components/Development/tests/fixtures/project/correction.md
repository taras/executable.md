<Development.Implementor session="journey-implementor" request="Implement fixture-r1." as="attemptOne" />
<Development.Planner session="journey-planner" request="Review fixture-r1." as="rejection" />
<AssertEquals actual={rejection} expected="REQUEST CHANGES: fixture-r1 omits the required label." />

<Development.Implementor session="journey-implementor" request={"Correct fixture-r1.\n\n" + rejection} as="attemptTwo" />
<Development.Architect session="journey-architect" request="Review fixture-r2." as="architectReview" />
<Development.Planner session="journey-planner" request="Review fixture-r2." as="plannerReview" />

<AssertEquals actual={attemptOne} expected={"Fixture revision: fixture-r1\n\n**Attempt one** is preserved."} />
<AssertEquals actual={attemptTwo} expected={"Fixture revision: fixture-r2\n\n**Attempt two** includes the required label."} />
<AssertEquals actual={architectReview} expected="PASS: Architect reviewed fixture-r2." />
<AssertEquals actual={plannerReview} expected="PASS: Planner reviewed fixture-r2." />

Correction handoff verified for fixture-r2; fixture-r1 remains preserved.
