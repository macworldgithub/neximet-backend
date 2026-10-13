const Project = require('../models/Project');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const LeaveRequest = require('../models/LeaveRequest');

const { companyDate: getTodayString, shiftDate, scheduledEnd } = require('../services/attendancePolicy');
const { activeRule, closeEndedShifts, dailyRoster } = require('../services/attendanceRecords');

// @desc    Get roll-up dashboard metrics tailored to logged-in user role and department
// @route   GET /api/dashboard/stats
exports.getStats = async (req, res) => {
  try {
    const rule = await activeRule();
    const todayStr = shiftDate(new Date(), rule);
    await closeEndedShifts(rule);
    const currentMonthPrefix = todayStr.substring(0, 7);

    const currentUser = req.user;
    const isExecutive = ['CEO', 'Super Admin'].includes(currentUser?.role);
    const isManager = ['Project Manager', 'Team Manager'].includes(currentUser?.role);
    const userDept = currentUser?.department;

    // 1. Projects Statistics (Scoped for department if not executive)
    const projectFilter = (!isExecutive && userDept && userDept !== 'Executive')
      ? { department: userDept }
      : {};

    const allProjects = await Project.find(projectFilter)
      .select('title code department status completionPercentage deadline clientName priority');
    const totalProjects = allProjects.length;
    const activeProjects = allProjects.filter((p) => p.status === 'in_progress').length;
    const completedProjects = allProjects.filter((p) => p.status === 'completed').length;
    const reviewProjects = allProjects.filter((p) => p.status === 'review').length;
    const planningProjects = allProjects.filter((p) => p.status === 'planning').length;

    // Department-wise project counts & completion averages
    const allDepartments = [
      'Software Development',
      'Digital Marketing (SEO)',
      'Graphics Designing',
      'WordPress Team',
    ];

    const displayDepartments = (!isExecutive && userDept && userDept !== 'Executive')
      ? [userDept]
      : allDepartments;

    const departmentStats = displayDepartments.map((dept) => {
      const deptProjects = allProjects.filter((p) => p.department === dept);
      const count = deptProjects.length;
      const avgProgress = count > 0
        ? Math.round(deptProjects.reduce((acc, p) => acc + (p.completionPercentage || 0), 0) / count)
        : 0;
      const activeCount = deptProjects.filter((p) => p.status === 'in_progress').length;

      return {
        department: dept,
        totalProjects: count,
        activeProjects: activeCount,
        avgProgress,
      };
    });

    // 2. Personal Tasks assigned to this user
    const Task = require('../models/Task');
    const myTasks = await Task.find({ assignedTo: currentUser._id })
      .populate('project', 'title code department')
      .sort({ updatedAt: -1 });

    const myTasksCount = myTasks.length;
    const myActiveTasks = myTasks.filter((t) => t.status === 'in_progress').length;
    const myReviewTasks = myTasks.filter((t) => t.status === 'review').length;
    const myDoneTasks = myTasks.filter((t) => t.status === 'done' || t.status === 'completed').length;
    const myTodoTasks = myTasks.filter((t) => t.status === 'todo' || t.status === 'backlog').length;

    // 3. Attendance & Telemetry Scoping
    // A. Personal Attendance
    let myTodayRecord = await Attendance.findOne({ user: currentUser._id, date: todayStr });
    const myMonthRecords = await Attendance.find({
      user: currentUser._id,
      date: { $regex: `^${currentMonthPrefix}` },
    });
    const myMonthlyPresentCount = myMonthRecords.filter((r) => ['present', 'late', 'half_day'].includes(r.status)).length;
    const myMonthlyLateCount = myMonthRecords.filter((r) => r.isLate).length;
    const myMonthlyDeductionsTotal = myMonthRecords.reduce((sum, r) => sum + (r.deductionAmount || 0), 0);

    // B. Department Attendance & Squad Members
    const deptUsers = (!isExecutive && userDept && userDept !== 'Executive')
      ? await User.find({ department: userDept, isActive: true }).select('name email role designation department phone')
      : [];
    const deptTotalEmployees = deptUsers.length;

    // C. Company-wide Attendance
    const companyRoster = await dailyRoster(todayStr);
    // CEO testing must not inflate company employee attendance counts.
    const todayRecords = companyRoster.filter(row => row.user.role !== 'CEO');
    const totalEmployees = todayRecords.length;
    const presentCount = todayRecords.filter((r) => r.status === 'present').length;
    const lateCount = todayRecords.filter((r) => r.isLate).length;
    const halfDayCount = todayRecords.filter((r) => r.status === 'half_day').length;
    const checkedInCount = todayRecords.filter((r) => r.checkedIn).length;
    const shiftEnded = new Date() >= scheduledEnd(todayStr, rule);
    const absentCount = todayRecords.filter((r) => r.status === 'absent' || (shiftEnded && r.status === 'not_checked_in')).length;
    const notCheckedInCount = todayRecords.filter((r) => r.status === 'not_checked_in').length;
    const onLeaveCount = todayRecords.filter((r) => r.status === 'on_leave').length;
    const onHolidayCount = todayRecords.filter((r) => r.status === 'on_holiday').length;
    if (!myTodayRecord) {
      const own = companyRoster.find(r => String(r.user._id) === String(currentUser._id));
      if (own && ['on_leave', 'on_holiday'].includes(own.status)) myTodayRecord = own;
    }
    const todayDeductionTotal = todayRecords.reduce((sum, r) => sum + (r.deductionAmount || 0), 0);

    // Department-scoped today attendance
    const deptTodayRecords = todayRecords.filter((r) => r.user && r.user.department === userDept);
    const deptCheckedInCount = deptTodayRecords.filter((r) => r.checkedIn).length;
    const deptPresentCount = deptTodayRecords.filter((r) => r.status === 'present').length;
    const deptLateCount = deptTodayRecords.filter((r) => r.isLate).length;
    const deptAbsentCount = deptTodayRecords.filter((r) => r.status === 'absent' || (shiftEnded && r.status === 'not_checked_in')).length;

    // Company monthly deductions (only computed for CEO/Super Admin)
    let companyMonthlyDeductionsTotal = 0;
    if (isExecutive) {
      const monthRecords = await Attendance.find({
        date: { $regex: `^${currentMonthPrefix}` },
        deductionAmount: { $gt: 0 },
        isSimulated: { $ne: true },
      });
      companyMonthlyDeductionsTotal = monthRecords.reduce((sum, r) => sum + (r.deductionAmount || 0), 0);
    }

    // 4. Critical Upcoming Deadlines
    const now = new Date();
    const upcomingDeadlines = allProjects
      .filter((p) => p.status !== 'completed' && new Date(p.deadline) >= now)
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
      .slice(0, 5);

    // 5. Pending Leaves Count
    const pendingLeavesCount = isExecutive
      ? await LeaveRequest.countDocuments({ status: 'pending' })
      : await LeaveRequest.countDocuments({ user: currentUser._id, status: 'pending' });

    // 6. Department Squad Members live status
    const squadMembers = (!isExecutive && userDept && userDept !== 'Executive')
      ? deptUsers.map((u) => {
          const rec = deptTodayRecords.find((r) => r.user?._id?.toString() === u._id.toString());
          return {
            _id: u._id,
            name: u.name,
            email: u.email,
            role: u.role,
            designation: u.designation,
            phone: u.phone,
            todayStatus: rec ? rec.status : 'not_checked_in',
            checkIn: rec ? rec.checkIn : null,
            isLate: rec ? rec.isLate : false,
          };
        })
      : [];

    res.json({
      success: true,
      userScope: {
        role: currentUser.role,
        department: currentUser.department,
        isExecutive,
        isManager,
        isMember: !isExecutive && !isManager,
      },
      projects: {
        total: totalProjects,
        active: activeProjects,
        completed: completedProjects,
        inReview: reviewProjects,
        planning: planningProjects,
        departmentBreakdown: departmentStats,
      },
      tasks: {
        total: myTasksCount,
        active: myActiveTasks,
        review: myReviewTasks,
        done: myDoneTasks,
        todo: myTodoTasks,
        myRecentTasks: myTasks.slice(0, 6).map((t) => ({
          _id: t._id,
          title: t.title,
          issueKey: t.issueKey,
          status: t.status,
          priority: t.priority,
          deadline: t.deadline,
          project: t.project,
        })),
      },
      attendance: {
        totalEmployees,
        checkedInToday: checkedInCount,
        presentCount,
        lateCount,
        halfDayCount,
        absentCount,
        notCheckedInCount,
        onLeaveCount,
        onHolidayCount,
        todayDeductions: todayDeductionTotal,
        monthlyDeductions: companyMonthlyDeductionsTotal,

        // Department telemetry
        deptTotalEmployees,
        deptCheckedInToday: deptCheckedInCount,
        deptPresentCount,
        deptLateCount,
        deptAbsentCount,

        // Personal telemetry
        myTodayStatus: myTodayRecord ? {
          status: myTodayRecord.status,
          checkIn: myTodayRecord.checkIn,
          isLate: myTodayRecord.isLate,
          minutesLate: myTodayRecord.minutesLate,
          deductionAmount: myTodayRecord.deductionAmount,
          deductionReason: myTodayRecord.deductionReason,
        } : null,
        myMonthlyPresentCount,
        myMonthlyLateCount,
        myMonthlyDeductions: myMonthlyDeductionsTotal,
      },
      upcomingDeadlines,
      pendingLeavesCount,
      squadMembers,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get consolidated administrative notifications for CEO / Super Admin
// @route   GET /api/dashboard/admin-notifications
exports.getAdminNotifications = async (req, res) => {
  try {
    const todayStr = getTodayString();
    const Task = require('../models/Task');

    // 1. Pending Leaves
    const pendingLeaves = await LeaveRequest.find({ status: 'pending' })
      .populate('user', 'name email department designation')
      .sort({ createdAt: -1 });

    // 2. Pending Password Reset Requests
    const passwordUsers = await User.find({ 'passwordResetRequest.status': 'Pending' })
      .select('name email role department designation phone passwordResetRequest updatedAt')
      .sort({ 'passwordResetRequest.requestedAt': -1 });

    const pendingPasswords = passwordUsers.map((u) => ({
      _id: u._id,
      user: {
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        department: u.department,
        designation: u.designation,
      },
      name: u.name,
      email: u.email,
      role: u.role,
      department: u.department,
      requestedAt: u.passwordResetRequest?.requestedAt || u.updatedAt,
    }));

    // 3. Today's Attendance Discrepancies (late check-ins >= 10 mins)
    const lateToday = await Attendance.find({
      date: todayStr,
      isLate: true,
      minutesLate: { $gte: 10 },
    })
      .populate('user', 'name email department designation')
      .sort({ minutesLate: -1 });

    const attendanceAlerts = lateToday.map((a) => ({
      _id: a._id,
      user: a.user,
      name: a.user?.name || 'Staff Member',
      email: a.user?.email || '',
      department: a.user?.department || '',
      minutesLate: a.minutesLate,
      deductionAmount: a.deductionAmount,
      checkIn: a.checkIn,
    }));

    // 4. Urgent Tasks & Reviews
    const taskAlerts = await Task.find({
      $or: [
        { status: 'review' },
        { priority: 'Urgent', status: { $ne: 'done' } },
      ],
    })
      .populate('project', 'title code')
      .populate('assignedTo', 'name email department')
      .sort({ updatedAt: -1 })
      .limit(6);

    const totalCount =
      pendingLeaves.length +
      pendingPasswords.length +
      attendanceAlerts.length +
      taskAlerts.length;

    res.json({
      success: true,
      totalCount,
      counts: {
        leaves: pendingLeaves.length,
        passwords: pendingPasswords.length,
        attendance: attendanceAlerts.length,
        tasks: taskAlerts.length,
      },
      notifications: {
        leaves: pendingLeaves,
        passwords: pendingPasswords,
        attendance: attendanceAlerts,
        tasks: taskAlerts,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
