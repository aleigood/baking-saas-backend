import { Controller, Body, Patch, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    @Patch('me/profile')
    updateProfile(@GetUser() user: UserPayload, @Body() updateProfileDto: UpdateProfileDto) {
        return this.usersService.updateProfile(user.sub, updateProfileDto);
    }

    @Patch('me/password')
    changePassword(@GetUser() user: UserPayload, @Body() changePasswordDto: ChangePasswordDto) {
        return this.usersService.changePassword(user.sub, changePasswordDto);
    }
}
